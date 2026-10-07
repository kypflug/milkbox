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
import { counters } from './sync-stats';

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

let dbPromise: Promise<IDBDatabase> | null = null;

/** One connection for the page's lifetime, reopened if it is ever lost. */
function openBackupDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading, or WebKit closing the connection while the
      // app sat suspended: forget it so the next backup reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** The snapshot last written, so an unchanged cache costs no write. */
let lastSnapshot = '';
let backupRunning: Promise<void> | null = null;
let backupAgain = false;
/** Sign-out has begun: this page writes no more snapshots (see clearMsalCacheBackup). */
let backupsDisabled = false;
/** The snapshot write in flight, so sign-out can abort one that has stalled. */
let activeWrite: IDBTransaction | null = null;

/**
 * Set from the moment sign-out starts clearing the backup until the delete
 * is known to have landed. IndexedDB can stall (on iOS above all) and
 * sign-out does not wait for it for ever; a snapshot it could not delete
 * must still not be restored on the next boot, which would sign the user
 * straight back in. Kept in localStorage because that is synchronous: it is
 * in place before sign-out's first await, whatever happens to the page next.
 *
 * It shares localStorage's fate, though. If iOS evicts localStorage before
 * the next launch, the mark goes with the token cache, and a snapshot that
 * could not be deleted is restored after all.
 */
const REVOKED_KEY = 'milkbox:backup-revoked';

/**
 * Changed by the tab that signs out, every time it starts clearing the
 * backup, and never taken back: what tells any page, in any tab, that a
 * sign-out has started since it last looked. The revoked mark alone would
 * not, because a delete that lands promptly lifts it again.
 *
 * - A restore that was waiting on IndexedDB reads it before and after, and
 *   does not write back a snapshot it read across a sign-out.
 * - A page that finds it changed since it loaded writes no more snapshots
 *   (see signOutBegun).
 * - The mark is only lifted by whoever has seen no sign-out start in the
 *   meantime (see liftRevoked).
 *
 * Only the signing-out tab changes it. A tab that is merely told of the
 * sign-out may hear of it late — after the next session has signed in —
 * and a stamp from it then would stop that session's pages backing up.
 */
const REVOCATION_STAMP_KEY = 'milkbox:backup-revocation';

function revocationStamp(): string | null {
  try {
    return localStorage.getItem(REVOCATION_STAMP_KEY);
  } catch {
    return null;
  }
}

function isRevoked(): boolean {
  try {
    return localStorage.getItem(REVOKED_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * A sign-out starts, or reaches its delete: a new stamp, then the mark. In
 * that order, so that a page which can see the mark can see the stamp too.
 */
function markRevoked(): void {
  try {
    localStorage.setItem(REVOCATION_STAMP_KEY, `${Date.now()}-${Math.random()}`);
    localStorage.setItem(REVOKED_KEY, '1');
  } catch {
    // localStorage unavailable: the bounded delete below is all there is
  }
}

/**
 * Lift the mark — unless a sign-out has started since `stamp` was read. The
 * caller read it before the work that entitles it to lift: a delete that
 * has since landed, or a snapshot written by a session that is still good.
 * A sign-out that started during that work set the mark for a reason this
 * caller knows nothing about, and its mark stays.
 *
 * As far as this page can see, that is. localStorage has no
 * compare-and-set, and a page sees another tab's writes only between its
 * own tasks: a sign-out that started in another tab an instant ago may not
 * show here yet, and looking again within this call would not find it.
 * What covers that instant is that a sign-out does not rely on one mark:
 * it marks again, seconds later, just before its delete (see
 * clearMsalCacheBackup), and by then every page has seen the first stamp.
 */
function liftRevoked(stamp: string | null): void {
  try {
    if (localStorage.getItem(REVOCATION_STAMP_KEY) !== stamp) return;
    localStorage.removeItem(REVOKED_KEY);
  } catch {
    // localStorage unavailable: there is no mark to lift
  }
}

/**
 * The stamp as this page found it when it loaded. One that differs later
 * was set by a sign-out that started after this page loaded, so the session
 * this page loaded with is the one that sign-out ends. (The page of a later
 * session loads after it, and finds its stamp already there.)
 */
const stampAtLoad = revocationStamp();

/**
 * A sign-out has started since this page loaded: here, or in another tab,
 * which this one may not have heard from yet (the broadcast comes later
 * than the stamp, and a page that was suspended gets it later still). The
 * token cache this page would snapshot is the session being signed out, so
 * it writes no more snapshots, and none it had under way lifts the mark.
 */
function signOutBegun(): boolean {
  return backupsDisabled || revocationStamp() !== stampAtLoad;
}

/** How long sign-out lets a snapshot write already under way finish. */
const WRITE_WAIT_MS = 2000;
/** How long the delete itself may take before sign-out goes on without it. */
const DELETE_WAIT_MS = 3000;

/**
 * Snapshot all MSAL-related localStorage entries to IndexedDB.
 * Call after successful sign-in and token acquisition.
 *
 * One write at a time: a call that arrives mid-write asks for one more pass
 * afterwards, so the last change always lands without stacking writes.
 */
export function backupMsalCache(): Promise<void> {
  if (signOutBegun()) return Promise.resolve();
  if (backupRunning) {
    backupAgain = true;
    return backupRunning;
  }
  backupRunning = (async () => {
    try {
      do {
        backupAgain = false;
        await writeSnapshot();
      } while (backupAgain && !signOutBegun());
    } finally {
      backupRunning = null;
    }
  })();
  return backupRunning;
}

async function writeSnapshot(): Promise<void> {
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

    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSnapshot) return;

    const db = await openBackupDB();
    // Sign-out began while the connection was opening: nothing more is written.
    if (signOutBegun()) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      activeWrite = tx;
      const settle = () => {
        if (activeWrite === tx) activeWrite = null;
      };
      tx.objectStore(STORE_NAME).put(snapshot, SNAPSHOT_KEY);
      tx.oncomplete = () => {
        settle();
        lastSnapshot = serialized;
        counters.backups++;
        // A snapshot of a signed-in session replaces whatever a past sign-out
        // failed to delete. Not when a sign-out has started since this page
        // loaded, in this tab or another: this write was then under way as
        // it began, the snapshot is of the session it is ending, and the
        // mark is that sign-out's.
        if (!backupsDisabled) liftRevoked(stampAtLoad);
        console.debug('[AuthBackup] Saved %d MSAL keys to IndexedDB', Object.keys(snapshot).length);
        resolve();
      };
      tx.onerror = () => {
        settle();
        reject(tx.error);
      };
      tx.onabort = () => {
        settle();
        reject(tx.error);
      };
    });
  } catch (err) {
    dbPromise = null; // a dead connection throws on transaction(); reopen next time
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

    // A sign-out revoked the backup but could not confirm it was deleted:
    // not restored. Deleting it is tried again, without holding boot up.
    if (isRevoked()) {
      void deleteSnapshot(DELETE_WAIT_MS);
      return false;
    }

    // localStorage is empty — try to restore from IndexedDB
    const stampBefore = revocationStamp();
    const db = await openBackupDB();
    const snapshot = await new Promise<Record<string, string> | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result as Record<string, string> | undefined);
      req.onerror = () => reject(req.error);
    });

    if (!snapshot || Object.keys(snapshot).length === 0) return false;

    // Opening and reading can take a while, and a sign-out may have started
    // meanwhile — in another tab, or here on hearing of one. The snapshot
    // just read is then the account being signed out: writing it back would
    // undo that. The mark shows a sign-out still clearing the backup; the
    // stamp, one whose delete has already landed and lifted the mark.
    if (backupsDisabled || isRevoked() || revocationStamp() !== stampBefore) return false;

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
 * Delete the snapshot, giving up after `ms`. Resolves true only once the
 * delete has committed, and lifts the revoked mark then — unless another
 * sign-out has started since this delete was asked for: what is stored by
 * then may have been written after the delete, and is that sign-out's to
 * clear. Never rejects.
 *
 * A delete still waiting its turn at the limit is aborted, so it cannot run
 * later, over a snapshot written since by a session that signed in
 * afterwards. (One already committing lands regardless; the mark it would
 * have lifted stays set until the next launch retries.)
 */
function deleteSnapshot(ms: number): Promise<boolean> {
  const stamp = revocationStamp();
  return new Promise(resolve => {
    let tx: IDBTransaction | null = null;
    let settled = false;
    const finish = (deleted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (deleted) liftRevoked(stamp);
      resolve(deleted);
    };
    const timer = setTimeout(() => {
      if (tx) {
        try {
          tx.abort();
        } catch {
          // it finished in the meantime
        }
      } else {
        dbPromise = null; // the open never came back: don't hand it to the next caller
      }
      finish(false);
    }, ms);
    const run = async () => {
      let db = await openBackupDB();
      if (settled) return;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
      } catch {
        // A connection WebKit closed while the app sat suspended throws
        // here. A fresh one usually works: try once.
        dbPromise = null;
        db = await openBackupDB();
        if (settled) return;
        tx = db.transaction(STORE_NAME, 'readwrite');
      }
      tx.objectStore(STORE_NAME).delete(SNAPSHOT_KEY);
      tx.oncomplete = () => finish(true);
      tx.onerror = () => finish(false);
      tx.onabort = () => finish(false);
    };
    run().catch(() => {
      dbPromise = null;
      finish(false);
    });
  });
}

/**
 * Sign-out has begun: from this instant this page writes no more snapshots,
 * and no page restores the one that is stored. Synchronous, for the caller
 * to do before its first await — clearMsalCacheBackup, which finishes the
 * job, can come seconds later (the local store is wiped first), and a page
 * launched in between must not find the snapshot still good to restore.
 */
export function revokeMsalCacheBackup(): void {
  backupsDisabled = true;
  markRevoked();
}

/**
 * Clear the IndexedDB backup: on explicit sign-out, and, with `told`, in a
 * tab that hears of a sign-out in another. Never rejects, and never takes
 * longer than WRITE_WAIT_MS + DELETE_WAIT_MS.
 *
 * Ordered so nothing can put the snapshot back: first no new backups from
 * this page (the pagehide hook would otherwise snapshot the cache on the way
 * out), then let one already writing finish, then delete. A snapshot that
 * survived sign-out would be restored on the next boot and sign the user
 * straight back in.
 *
 * IndexedDB may not answer at all. Then neither wait here holds sign-out up.
 * A write still waiting its turn is aborted, so the delete is not queued
 * behind it and it cannot land afterwards. One already committing cannot be
 * aborted: the delete is ordered after it. And whenever the delete does not
 * land in time, the revoked mark stays set, which is what keeps a snapshot
 * left behind from being restored.
 *
 * A tab that is told stops its own backups and helps with the delete, but
 * starts no revocation of its own: no stamp, no mark. The signing-out tab
 * set both before it sent word. And it deletes only while that tab's mark
 * still stands. Told late — it was suspended, and another session has
 * signed in since — it finds the mark lifted, and what is stored then is
 * that session's snapshot, not something of this sign-out's to remove.
 */
export async function clearMsalCacheBackup(opts: { told?: boolean } = {}): Promise<void> {
  if (opts.told) backupsDisabled = true;
  else revokeMsalCacheBackup();
  const writing = backupRunning;
  if (writing) {
    const finished = await Promise.race([
      writing.then(() => true, () => true),
      new Promise<boolean>(r => setTimeout(() => r(false), WRITE_WAIT_MS)),
    ]);
    if (!finished) {
      if (activeWrite) {
        try {
          activeWrite.abort();
        } catch {
          // committing already (or just finished): the delete follows it
        }
      } else {
        // Stuck opening the database. The write gives up when the open does
        // come back (see writeSnapshot); the delete asks for a connection of
        // its own, under its own limit.
        dbPromise = null;
      }
    }
  }
  lastSnapshot = '';
  if (opts.told) {
    if (isRevoked()) await deleteSnapshot(DELETE_WAIT_MS);
    return;
  }
  // Marked again: another tab told of this sign-out may have confirmed its
  // own delete, and lifted the mark, before this page's write had finished.
  // (The new stamp also stops a page that loaded since the first one.)
  markRevoked();
  await deleteSnapshot(DELETE_WAIT_MS);
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
