/**
 * IndexedDB store for Milkbox — the real offline store (the service worker
 * only precaches the app shell). Tiny promise wrapper, no dependency.
 *
 * Since v3 every drop-shaped store is namespaced by scope ('private' or
 * 'chat:<ulid>') so shared chats can never collide with the private feed:
 * - drops:    StoredDropRecord keyed by [scopeId, meta.id]
 * - thumbs:   image thumbnail bytes keyed by `${scopeId}/${dropId}`
 * - blobs:    full image bytes keyed by `${scopeId}/${dropId}` (LRU capped)
 * - outbox:   OutboxRecord keyed by id (locally minted ULIDs; scopeId field)
 * - devices:  DeviceProfile keyed by id (private-feed concept only)
 * - chats:    ChatRecord keyed by chat id — the local chat registry
 * - settings: small key/value pairs (per-scope delta tokens / cTags, etc.)
 */

import type { ChatRecord, DeviceProfile, DropRecord, OutboxRecord, ScopeId } from '../types';

const DB_NAME = 'milkbox-db';
const DB_VERSION = 3;

/** Sorts after every ULID character — the top of a scope's key range. */
const RANGE_CEIL = '￿';

type StoredDropRecord = DropRecord & { scopeId: ScopeId };

/** Settings keys migrated from the pre-multiplayer singletons. */
const V3_SETTINGS_RENAMES: ReadonlyArray<[string, string]> = [
  ['milkbox:delta-token', 'milkbox:delta-token:private'],
  ['milkbox:drops-ctag', 'milkbox:ctag:private'],
  ['milkbox:notify-primed', 'milkbox:notify-primed:private'],
];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    req.onupgradeneeded = event => {
      const db = req.result;
      const tx = req.transaction!;
      const oldVersion = event.oldVersion;

      // Stores that keep their shape — create when missing (fresh installs
      // and the v1 scaffold, which predates some of them).
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs');
      if (!db.objectStoreNames.contains('blobs')) {
        const blobs = db.createObjectStore('blobs', { keyPath: 'id' });
        blobs.createIndex('lastAccess', 'lastAccess');
      }
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('devices')) db.createObjectStore('devices', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });

      if (oldVersion < 1 || !db.objectStoreNames.contains('drops')) {
        // Fresh install — create the scoped store directly.
        db.createObjectStore('drops', { keyPath: ['scopeId', 'meta.id'] });
      } else if (oldVersion < 3) {
        // v1/v2 → v3: existing data is all the private feed.
        //
        // drops: snapshot into memory (small JSON records), recreate the
        // store with the compound key, re-put stamped with 'private'.
        // Snapshot-then-write — never a live cursor over a store that is
        // receiving lexically-later keys, which would revisit its own inserts.
        const oldDrops = tx.objectStore('drops');
        const dropsReq = oldDrops.getAll() as IDBRequest<DropRecord[]>;
        dropsReq.onsuccess = () => {
          const records = dropsReq.result;
          db.deleteObjectStore('drops');
          const drops = db.createObjectStore('drops', { keyPath: ['scopeId', 'meta.id'] });
          for (const record of records) drops.put({ ...record, scopeId: 'private' } satisfies StoredDropRecord);
        };

        // thumbs/blobs are re-fetchable caches — clearing beats rewriting
        // up to 200 MB of bytes inside one upgrade transaction.
        tx.objectStore('thumbs').clear();
        tx.objectStore('blobs').clear();

        // outbox: stamp the destination scope (snapshot, key unchanged).
        const outboxStore = tx.objectStore('outbox');
        const outboxReq = outboxStore.getAll() as IDBRequest<OutboxRecord[]>;
        outboxReq.onsuccess = () => {
          for (const record of outboxReq.result) {
            outboxStore.put({ ...record, scopeId: record.scopeId ?? 'private' });
          }
        };

        // settings: singletons become the private scope's keys.
        const settings = tx.objectStore('settings');
        for (const [oldKey, newKey] of V3_SETTINGS_RENAMES) {
          const getReq = settings.get(oldKey);
          getReq.onsuccess = () => {
            if (getReq.result !== undefined) {
              settings.put(getReq.result, newKey);
              settings.delete(oldKey);
            }
          };
        }
      }
    };
    req.onblocked = () => {
      blocked = true;
      // Reset the memoized promise so a reload (or a later call after the
      // blocking tab closes) can retry instead of failing forever.
      dbPromise = null;
      reject(new Error('Milkbox storage upgrade is blocked. Close other Milkbox windows and reload.'));
    };
    req.onsuccess = () => {
      if (blocked) {
        req.result.close();
        return;
      }
      req.result.onversionchange = () => {
        // A newer build in another tab is upgrading — release the connection
        // and drop the memoized promise so our next access reopens cleanly.
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
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

// ─── drops (scoped) ───

function scopeRange(scopeId: ScopeId): IDBKeyRange {
  return IDBKeyRange.bound([scopeId, ''], [scopeId, RANGE_CEIL]);
}

export function getScopeDrops(scopeId: ScopeId): Promise<DropRecord[]> {
  return tx('drops', 'readonly', s => s.getAll(scopeRange(scopeId)) as IDBRequest<DropRecord[]>);
}

export function putDrop(scopeId: ScopeId, record: DropRecord): Promise<void> {
  return tx('drops', 'readwrite', s => { s.put({ ...record, scopeId } satisfies StoredDropRecord); });
}

export function deleteDrop(scopeId: ScopeId, id: string): Promise<void> {
  return tx('drops', 'readwrite', s => { s.delete([scopeId, id]); });
}

export function getDrop(scopeId: ScopeId, id: string): Promise<DropRecord | undefined> {
  return tx('drops', 'readonly', s => s.get([scopeId, id]) as IDBRequest<DropRecord | undefined>);
}

/** Just the ids in a scope's feed — a key-only read, nothing deserialized. */
export async function getScopeDropIds(scopeId: ScopeId): Promise<string[]> {
  const keys = await tx('drops', 'readonly', s => s.getAllKeys(scopeRange(scopeId)) as IDBRequest<IDBValidKey[]>);
  return (keys as Array<[string, string]>).map(key => key[1]);
}

/** Drop id → eTag for a scope — the listing fallback's reconcile input. */
export async function getScopeDropETags(scopeId: ScopeId): Promise<Map<string, string | undefined>> {
  const records = await getScopeDrops(scopeId);
  return new Map(records.map(r => [r.meta.id, r.eTag]));
}

/** Replace one scope's drops (full re-delta reconcile). Scope-bounded — a
 *  chat resync can never touch the private feed or another chat. */
export async function replaceScopeDrops(scopeId: ScopeId, records: DropRecord[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('drops', 'readwrite');
    const s = t.objectStore('drops');
    s.delete(scopeRange(scopeId));
    for (const r of records) s.put({ ...r, scopeId } satisfies StoredDropRecord);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ─── thumbs (scoped keys) ───

const mediaKey = (scopeId: ScopeId, dropId: string) => `${scopeId}/${dropId}`;

function mediaRange(scopeId: ScopeId): IDBKeyRange {
  return IDBKeyRange.bound(`${scopeId}/`, `${scopeId}/${RANGE_CEIL}`);
}

export function getThumb(scopeId: ScopeId, dropId: string): Promise<Blob | undefined> {
  return tx('thumbs', 'readonly', s => s.get(mediaKey(scopeId, dropId)) as IDBRequest<Blob | undefined>);
}

export function putThumb(scopeId: ScopeId, dropId: string, blob: Blob): Promise<void> {
  return tx('thumbs', 'readwrite', s => { s.put(blob, mediaKey(scopeId, dropId)); });
}

export function deleteThumb(scopeId: ScopeId, dropId: string): Promise<void> {
  return tx('thumbs', 'readwrite', s => { s.delete(mediaKey(scopeId, dropId)); });
}

// ─── blobs (full images, LRU capped, scoped keys) ───

interface BlobEntry {
  id: string;
  blob: Blob;
  size: number;
  lastAccess: number;
}

const BLOB_CACHE_CAP_BYTES = 200 * 1024 * 1024;

export async function getCachedBlob(scopeId: ScopeId, dropId: string): Promise<Blob | undefined> {
  const key = mediaKey(scopeId, dropId);
  const entry = await tx<BlobEntry | undefined>('blobs', 'readonly', s => s.get(key) as IDBRequest<BlobEntry | undefined>);
  if (entry) {
    // Touch lastAccess (fire-and-forget)
    tx('blobs', 'readwrite', s => { s.put({ ...entry, lastAccess: Date.now() }); }).catch(() => {});
    return entry.blob;
  }
  return undefined;
}

export async function putCachedBlob(scopeId: ScopeId, dropId: string, blob: Blob): Promise<void> {
  await tx('blobs', 'readwrite', s => {
    s.put({ id: mediaKey(scopeId, dropId), blob, size: blob.size, lastAccess: Date.now() } satisfies BlobEntry);
  });
  sweepBlobCache().catch(() => {});
}

export function deleteCachedBlob(scopeId: ScopeId, dropId: string): Promise<void> {
  return tx('blobs', 'readwrite', s => { s.delete(mediaKey(scopeId, dropId)); });
}

/** Evict least-recently-used blobs until the cache is under the cap. */
async function sweepBlobCache(): Promise<void> {
  const entries = await tx<BlobEntry[]>('blobs', 'readonly', s => s.getAll() as IDBRequest<BlobEntry[]>);
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= BLOB_CACHE_CAP_BYTES) return;
  const byAge = entries.sort((a, b) => a.lastAccess - b.lastAccess);
  for (const e of byAge) {
    if (total <= BLOB_CACHE_CAP_BYTES) break;
    await tx('blobs', 'readwrite', s => { s.delete(e.id); });
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

// ─── chats (local registry) ───

export function getAllChats(): Promise<ChatRecord[]> {
  return tx('chats', 'readonly', s => s.getAll() as IDBRequest<ChatRecord[]>);
}

export function getChat(id: string): Promise<ChatRecord | undefined> {
  return tx('chats', 'readonly', s => s.get(id) as IDBRequest<ChatRecord | undefined>);
}

export function putChat(record: ChatRecord): Promise<void> {
  return tx('chats', 'readwrite', s => { s.put(record); });
}

export function deleteChat(id: string): Promise<void> {
  return tx('chats', 'readwrite', s => { s.delete(id); });
}

/** Read-modify-write a chat record; a no-op when the chat is unknown. */
export async function patchChat(id: string, partial: Partial<ChatRecord>): Promise<void> {
  const existing = await getChat(id);
  if (!existing) return;
  await putChat({ ...existing, ...partial, id });
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

// ─── wipes ───

/** The per-scope settings keys that leave/delete must clean up. */
function scopeSettingsKeys(scopeId: ScopeId): string[] {
  return [
    `milkbox:delta-token:${scopeId}`,
    `milkbox:ctag:${scopeId}`,
    `milkbox:notify-primed:${scopeId}`,
    `milkbox:members:${scopeId}`,
  ];
}

/** Remove everything a scope owns locally (leave chat / chat gone / delete). */
export async function clearScopeData(scopeId: ScopeId): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['drops', 'thumbs', 'blobs', 'outbox', 'settings', 'chats'], 'readwrite');
    t.objectStore('drops').delete(scopeRange(scopeId));
    t.objectStore('thumbs').delete(mediaRange(scopeId));
    t.objectStore('blobs').delete(mediaRange(scopeId));
    for (const key of scopeSettingsKeys(scopeId)) t.objectStore('settings').delete(key);
    if (scopeId.startsWith('chat:')) t.objectStore('chats').delete(scopeId.slice(5));
    const outboxStore = t.objectStore('outbox');
    const req = outboxStore.getAll() as IDBRequest<OutboxRecord[]>;
    req.onsuccess = () => {
      for (const record of req.result) {
        if ((record.scopeId ?? 'private') === scopeId) outboxStore.delete(record.id);
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Wipe all local data (sign-out). */
export async function clearAllData(): Promise<void> {
  const db = await openDb();
  const stores = ['drops', 'thumbs', 'blobs', 'outbox', 'devices', 'chats', 'settings'];
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, 'readwrite');
    for (const s of stores) t.objectStore(s).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
