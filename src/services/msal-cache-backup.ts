/**
 * MSAL Cache Backup Service
 *
 * iOS aggressively evicts localStorage for PWAs — WKWebView process kills,
 * storage pressure, and OS updates can all wipe MSAL's token cache.
 * IndexedDB is significantly more durable on iOS.
 *
 * This service mirrors MSAL-related localStorage entries to IndexedDB after
 * every successful auth operation, and restores them on cold start if
 * localStorage was wiped.
 */

import { CLIENT_ID, ACCOUNT_HINT_KEY } from './auth-config';

const DB_NAME = 'milkbox-msal-backup';
const DB_VERSION = 1;
const STORE_NAME = 'msal-cache';
const SNAPSHOT_KEY = 'msal-snapshot';

/**
 * Patterns that identify MSAL localStorage keys.
 * MSAL v5 uses a mix of formats:
 *  - Account/credential keys containing the authority host
 *  - Metadata keys prefixed with "msal."
 *  - Interaction/request state keys
 *  - Our own account hint key
 */
const MSAL_KEY_PATTERNS = [
  'login.microsoftonline.com',
  'login.windows.net',
  'msal.',
  CLIENT_ID,
  ACCOUNT_HINT_KEY,
];

/** Returns true if a localStorage key belongs to MSAL or our auth layer. */
function isMsalKey(key: string): boolean {
  return MSAL_KEY_PATTERNS.some(p => key.includes(p));
}

/**
 * Keys matching these patterns are transient interaction state that must NOT
 * be persisted to IndexedDB. Restoring them after an iOS process kill causes
 * `interaction_in_progress` errors, blocking sign-in entirely.
 */
function isInteractionStateKey(key: string): boolean {
  return key.includes('interaction.status') || key.includes('request.params');
}

function openBackupDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Snapshot all MSAL-related localStorage entries to IndexedDB.
 * Call after successful sign-in and token acquisition.
 */
export async function backupMsalCache(): Promise<void> {
  try {
    const snapshot: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isMsalKey(key) && !isInteractionStateKey(key)) {
        const val = localStorage.getItem(key);
        if (val !== null) snapshot[key] = val;
      }
    }

    // Only write if there's meaningful data (at least one account/token entry)
    const hasTokenData = Object.keys(snapshot).some(
      k => k.includes('login.microsoftonline.com') || k.includes('login.windows.net'),
    );
    if (!hasTokenData) return;

    const db = await openBackupDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(snapshot, SNAPSHOT_KEY);
      tx.oncomplete = () => {
        console.debug('[AuthBackup] Saved %d MSAL keys to IndexedDB', Object.keys(snapshot).length);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[AuthBackup] Failed to backup MSAL cache:', err);
  }
}

/**
 * Restore MSAL cache from IndexedDB if localStorage was wiped.
 * Call BEFORE initialising MSAL so it picks up the restored tokens.
 *
 * Returns true if entries were restored (caller may want to log this).
 */
export async function restoreMsalCacheIfNeeded(): Promise<boolean> {
  try {
    // Check if localStorage already has MSAL data
    let hasMsalData = false;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isMsalKey(key) && (key.includes('login.microsoftonline.com') || key.includes('login.windows.net'))) {
        hasMsalData = true;
        break;
      }
    }

    if (hasMsalData) return false; // localStorage is fine, no restore needed

    // localStorage is empty — try to restore from IndexedDB
    const db = await openBackupDB();
    const snapshot = await new Promise<Record<string, string> | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result as Record<string, string> | undefined);
      req.onerror = () => reject(req.error);
    });

    if (!snapshot || Object.keys(snapshot).length === 0) return false;

    // Restore each key to localStorage, skipping stale interaction state
    let restored = 0;
    for (const [key, value] of Object.entries(snapshot)) {
      if (isInteractionStateKey(key)) continue;
      try {
        localStorage.setItem(key, value);
        restored++;
      } catch {
        // localStorage quota exceeded or unavailable — stop trying
        break;
      }
    }

    if (restored > 0) {
      console.info('[AuthBackup] Restored %d MSAL keys from IndexedDB backup', restored);
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[AuthBackup] Failed to restore MSAL cache:', err);
    return false;
  }
}

/**
 * Clear the IndexedDB backup (call on explicit sign-out).
 */
export async function clearMsalCacheBackup(): Promise<void> {
  try {
    const db = await openBackupDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Register listeners to backup MSAL cache before iOS kills the process.
 *
 * iOS aggressively terminates WKWebView processes when the PWA is
 * backgrounded. `pagehide` is the last reliable event before termination.
 * `visibilitychange: hidden` fires earlier (app switch) and gives more
 * time for the IndexedDB write to complete.
 *
 * Call once after entering the app (sign-in confirmed).
 */
export function setupBackgroundBackup(): void {
  let lastBackup = 0;
  const MIN_INTERVAL_MS = 60_000; // At most once per minute on visibility

  const debouncedBackup = () => {
    const now = Date.now();
    if (now - lastBackup < MIN_INTERVAL_MS) return;
    lastBackup = now;
    backupMsalCache().catch(() => {});
  };

  // pagehide — last chance before iOS process kill; always run (no debounce)
  window.addEventListener('pagehide', () => {
    backupMsalCache().catch(() => {});
  });

  // visibilitychange: hidden — fires on app switch, tab switch, etc.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') debouncedBackup();
  });
}
