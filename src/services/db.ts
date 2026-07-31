/**
 * IndexedDB store for Milkbox — the real offline store (the service worker
 * only precaches the app shell). Tiny promise wrapper, no dependency.
 *
 * Stores:
 * - drops:    DropRecord keyed by meta.id (the feed)
 * - thumbs:   image thumbnail bytes keyed by drop id
 * - blobs:    full image bytes keyed by drop id (LRU capped)
 * - outbox:   OutboxRecord keyed by id (pending sends, survives reloads)
 * - settings: small key/value pairs (delta token, folder cTag)
 */

import type { DeviceProfile, DropRecord, OutboxRecord } from '../types';

const DB_NAME = 'milkbox-db';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('drops')) {
        db.createObjectStore('drops', { keyPath: 'meta.id' });
      }
      if (!db.objectStoreNames.contains('thumbs')) {
        db.createObjectStore('thumbs');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        const blobs = db.createObjectStore('blobs', { keyPath: 'id' });
        blobs.createIndex('lastAccess', 'lastAccess');
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('devices')) {
        db.createObjectStore('devices', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
    };
    req.onblocked = () => {
      blocked = true;
      reject(new Error('Milkbox storage upgrade is blocked. Close other Milkbox windows and reload.'));
    };
    req.onsuccess = () => {
      if (blocked) {
        req.result.close();
        return;
      }
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let result: T;
        if (req) req.onsuccess = () => { result = req.result; };
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

// ─── drops ───

export function getAllDrops(): Promise<DropRecord[]> {
  return tx('drops', 'readonly', s => s.getAll() as IDBRequest<DropRecord[]>);
}

export function putDrop(record: DropRecord): Promise<void> {
  return tx('drops', 'readwrite', s => { s.put(record); });
}

export function deleteDrop(id: string): Promise<void> {
  return tx('drops', 'readwrite', s => { s.delete(id); });
}

export function getDrop(id: string): Promise<DropRecord | undefined> {
  return tx('drops', 'readonly', s => s.get(id) as IDBRequest<DropRecord | undefined>);
}

/** Just the ids in the feed — a key-only read, so no record is deserialized. */
export function getAllDropIds(): Promise<string[]> {
  return tx('drops', 'readonly', s => s.getAllKeys() as IDBRequest<string[]>);
}

/** Replace the entire drops store (full re-delta reconcile). */
export async function replaceAllDrops(records: DropRecord[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('drops', 'readwrite');
    const s = t.objectStore('drops');
    s.clear();
    for (const r of records) s.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ─── thumbs ───

export function getThumb(dropId: string): Promise<Blob | undefined> {
  return tx('thumbs', 'readonly', s => s.get(dropId) as IDBRequest<Blob | undefined>);
}

export function putThumb(dropId: string, blob: Blob): Promise<void> {
  return tx('thumbs', 'readwrite', s => { s.put(blob, dropId); });
}

export function deleteThumb(dropId: string): Promise<void> {
  return tx('thumbs', 'readwrite', s => { s.delete(dropId); });
}

// ─── blobs (full images, LRU capped) ───

interface BlobEntry {
  id: string;
  blob: Blob;
  size: number;
  lastAccess: number;
}

const BLOB_CACHE_CAP_BYTES = 200 * 1024 * 1024;

export async function getCachedBlob(dropId: string): Promise<Blob | undefined> {
  const entry = await tx<BlobEntry | undefined>('blobs', 'readonly', s => s.get(dropId) as IDBRequest<BlobEntry | undefined>);
  if (entry) {
    // Touch lastAccess (fire-and-forget)
    tx('blobs', 'readwrite', s => { s.put({ ...entry, lastAccess: Date.now() }); }).catch(() => {});
    return entry.blob;
  }
  return undefined;
}

export async function putCachedBlob(dropId: string, blob: Blob): Promise<void> {
  await tx('blobs', 'readwrite', s => {
    s.put({ id: dropId, blob, size: blob.size, lastAccess: Date.now() } satisfies BlobEntry);
  });
  sweepBlobCache().catch(() => {});
}

export function deleteCachedBlob(dropId: string): Promise<void> {
  return tx('blobs', 'readwrite', s => { s.delete(dropId); });
}

/** Evict least-recently-used blobs until the cache is under the cap. */
async function sweepBlobCache(): Promise<void> {
  const entries = await tx<BlobEntry[]>('blobs', 'readonly', s => s.getAll() as IDBRequest<BlobEntry[]>);
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= BLOB_CACHE_CAP_BYTES) return;
  const byAge = entries.sort((a, b) => a.lastAccess - b.lastAccess);
  for (const e of byAge) {
    if (total <= BLOB_CACHE_CAP_BYTES) break;
    await deleteCachedBlob(e.id);
    total -= e.size;
  }
}

// ─── outbox ───

export function getOutbox(): Promise<OutboxRecord[]> {
  return tx('outbox', 'readonly', s => s.getAll() as IDBRequest<OutboxRecord[]>);
}

export function putOutboxRecord(record: OutboxRecord): Promise<void> {
  return tx('outbox', 'readwrite', s => { s.put(record); });
}

export function deleteOutboxRecord(id: string): Promise<void> {
  return tx('outbox', 'readwrite', s => { s.delete(id); });
}

// ─── device profiles ───

export function getAllDeviceProfiles(): Promise<DeviceProfile[]> {
  return tx('devices', 'readonly', s => s.getAll() as IDBRequest<DeviceProfile[]>);
}

export function getDeviceProfile(id: string): Promise<DeviceProfile | undefined> {
  return tx('devices', 'readonly', s => s.get(id) as IDBRequest<DeviceProfile | undefined>);
}

export function putDeviceProfile(profile: DeviceProfile): Promise<void> {
  return tx('devices', 'readwrite', s => { s.put(profile); });
}

export async function replaceAllDeviceProfiles(profiles: DeviceProfile[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('devices', 'readwrite');
    const s = t.objectStore('devices');
    s.clear();
    for (const profile of profiles) s.put(profile);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ─── settings (kv) ───

export function getSetting<T>(key: string): Promise<T | undefined> {
  return tx('settings', 'readonly', s => s.get(key) as IDBRequest<T | undefined>);
}

export function putSetting<T>(key: string, value: T): Promise<void> {
  return tx('settings', 'readwrite', s => { s.put(value, key); });
}

export function deleteSetting(key: string): Promise<void> {
  return tx('settings', 'readwrite', s => { s.delete(key); });
}

/** Wipe all local data (sign-out). */
export async function clearAllData(): Promise<void> {
  const db = await openDb();
  const stores = ['drops', 'thumbs', 'blobs', 'outbox', 'devices', 'settings'];
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    for (const s of stores) t.objectStore(s).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
