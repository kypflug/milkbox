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

// ─── store epoch ───

const EPOCH_KEY = 'milkbox:epoch';

/**
 * The store's epoch as this page first found it (null when none has been
 * stored yet; undefined until the database is open).
 *
 * Sign-out and "Re-sync from scratch" start a new epoch. Every write then
 * checks, inside its own transaction, that the store is still on the epoch
 * its page knows, and is refused otherwise. So a pass that was mid-download
 * — in this tab or any other — when the store was wiped cannot write the old
 * state back afterwards, whether or not word of the wipe ever reached it.
 */
let pageEpoch: string | null | undefined;

/** A write from a page whose view of local storage has been superseded. */
export class StaleStoreError extends Error {
  constructor() {
    super('Local storage was reset by another action — this page is out of date');
    this.name = 'StaleStoreError';
  }
}

/** Start a new epoch inside `t`. `adopt` keeps this page current with it. */
function renewEpoch(t: IDBTransaction, adopt: boolean): void {
  const previous = pageEpoch;
  const next = crypto.randomUUID();
  const put = t.objectStore('settings').put(next, EPOCH_KEY);
  if (!adopt) return;
  put.onsuccess = () => {
    pageEpoch = next;
  };
  t.addEventListener('abort', () => {
    pageEpoch = previous;
  });
}

/**
 * Run `body` in one readwrite transaction over `stores`, once the epoch
 * check has passed in that same transaction. Resolves with the result of
 * the request `body` returns, if any.
 */
function write<T = void>(
  db: IDBDatabase,
  stores: string[],
  body: (t: IDBTransaction) => IDBRequest<T> | void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction([...new Set([...stores, 'settings'])], 'readwrite');
    let result: T;
    let stale = false;
    const epoch = t.objectStore('settings').get(EPOCH_KEY);
    epoch.onsuccess = () => {
      if ((epoch.result ?? null) !== pageEpoch) {
        stale = true;
        t.abort();
        return;
      }
      const req = body(t);
      if (req) req.onsuccess = () => { result = req.result; };
    };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(stale ? new StaleStoreError() : t.error);
  });
}

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
      const db = req.result;
      db.onversionchange = () => {
        // A newer build in another tab is upgrading — release the connection
        // and drop the memoized promise so our next access reopens cleanly.
        db.close();
        dbPromise = null;
      };
      // Learn the store's epoch once, before anything can write. A reopen
      // keeps the one this page already knows — reopening must not make a
      // stale page current.
      if (pageEpoch !== undefined) {
        resolve(db);
        return;
      }
      const epoch = db.transaction('settings', 'readonly').objectStore('settings').get(EPOCH_KEY);
      epoch.onsuccess = () => {
        pageEpoch = (epoch.result as string | undefined) ?? null;
        resolve(db);
      };
      epoch.onerror = () => {
        dbPromise = null;
        reject(epoch.error);
      };
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
  if (mode === 'readwrite') {
    return openDb().then(db => write<T>(db, [store], t => fn(t.objectStore(store))));
  }
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

/**
 * A write on behalf of one scope. For a chat it happens only while the chat
 * is still on this device, checked in the same transaction: work that
 * outlives a leave or delete — an outbox drain mid-retry, a sync batch, a
 * preview finishing its download — must not put rows back under the scope
 * that was just cleared. Resolves false when the write was skipped.
 */
async function writeForScope(
  scopeId: ScopeId,
  stores: string[],
  body: (t: IDBTransaction) => void,
): Promise<boolean> {
  const db = await openDb();
  const chatId = scopeId.startsWith('chat:') ? scopeId.slice(5) : null;
  let written = false;
  await write(db, chatId ? [...stores, 'chats'] : stores, t => {
    const apply = () => {
      body(t);
      written = true;
    };
    if (!chatId) {
      apply();
      return;
    }
    const chat = t.objectStore('chats').get(chatId);
    chat.onsuccess = () => {
      if (chat.result) apply();
    };
  });
  return written;
}

// ─── drops (scoped) ───

function scopeRange(scopeId: ScopeId): IDBKeyRange {
  return IDBKeyRange.bound([scopeId, ''], [scopeId, RANGE_CEIL]);
}

export function getScopeDrops(scopeId: ScopeId): Promise<DropRecord[]> {
  return tx('drops', 'readonly', s => s.getAll(scopeRange(scopeId)) as IDBRequest<DropRecord[]>);
}

export async function putDrop(scopeId: ScopeId, record: DropRecord): Promise<void> {
  await writeForScope(scopeId, ['drops'], t => {
    t.objectStore('drops').put({ ...record, scopeId } satisfies StoredDropRecord);
  });
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

export interface DropCommit {
  puts?: DropRecord[];
  /** Drop ids to remove, with their cached thumbnails and image bytes. */
  deletes?: string[];
  /** Settings written alongside — a pass's delta token and cTag. */
  settingsPut?: Array<[string, unknown]>;
  settingsDelete?: string[];
}

export interface DropCommitResult {
  /** False when the write was refused: the chat is no longer on this device. */
  written: boolean;
  /**
   * Ids among `puts` that this device did not hold until this commit. Decided
   * inside the transaction, so two tabs syncing the same scope can't both
   * count the same drop as new.
   */
  added: Set<string>;
}

/**
 * Apply a sync pass's changes to one scope in a single transaction, so the
 * delta token and cTag can never be stored without the drops they describe
 * (a killed app would otherwise resume past drops it never wrote).
 *
 * Puts land before deletes. For a chat scope the write is skipped entirely
 * when the chat record is gone — a pass that outlived a leave or delete must
 * not write drops back under the cleared scope.
 */
export async function commitDropChanges(scopeId: ScopeId, commit: DropCommit): Promise<DropCommitResult> {
  const added = new Set<string>();
  const written = await writeForScope(scopeId, ['drops', 'thumbs', 'blobs', 'settings'], t => {
    const drops = t.objectStore('drops');
    for (const r of commit.puts ?? []) {
      const held = drops.getKey([scopeId, r.meta.id]);
      held.onsuccess = () => {
        if (held.result === undefined) added.add(r.meta.id);
      };
      drops.put({ ...r, scopeId } satisfies StoredDropRecord);
    }
    for (const id of commit.deletes ?? []) {
      drops.delete([scopeId, id]);
      t.objectStore('thumbs').delete(mediaKey(scopeId, id));
      t.objectStore('blobs').delete(mediaKey(scopeId, id));
    }
    const settings = t.objectStore('settings');
    for (const [key, value] of commit.settingsPut ?? []) settings.put(value, key);
    for (const key of commit.settingsDelete ?? []) settings.delete(key);
  });
  return { written, added };
}

// ─── thumbs (scoped keys) ───

const mediaKey = (scopeId: ScopeId, dropId: string) => `${scopeId}/${dropId}`;

function mediaRange(scopeId: ScopeId): IDBKeyRange {
  return IDBKeyRange.bound(`${scopeId}/`, `${scopeId}/${RANGE_CEIL}`);
}

export function getThumb(scopeId: ScopeId, dropId: string): Promise<Blob | undefined> {
  return tx('thumbs', 'readonly', s => s.get(mediaKey(scopeId, dropId)) as IDBRequest<Blob | undefined>);
}

export async function putThumb(scopeId: ScopeId, dropId: string, blob: Blob): Promise<void> {
  await writeForScope(scopeId, ['thumbs'], t => {
    t.objectStore('thumbs').put(blob, mediaKey(scopeId, dropId));
  });
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
  await writeForScope(scopeId, ['blobs'], t => {
    t.objectStore('blobs').put(
      { id: mediaKey(scopeId, dropId), blob, size: blob.size, lastAccess: Date.now() } satisfies BlobEntry,
    );
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

/**
 * Queue a record. Resolves false, writing nothing, for a chat that has left
 * this device.
 */
export function putOutboxRecord(record: OutboxRecord): Promise<boolean> {
  return writeForScope(record.scopeId ?? 'private', ['outbox'], t => {
    t.objectStore('outbox').put(record);
  });
}

/**
 * Update a record that is still queued; resolves false, writing nothing,
 * when it no longer is. A drain can sit in a retry backoff for seconds: if
 * the send was cancelled meanwhile, or its chat removed (which deletes its
 * rows), the drain must find that out here — in any tab, and even if the
 * chat has been joined again since — and not put the row back.
 */
export async function updateOutboxRecord(record: OutboxRecord): Promise<boolean> {
  let updated = false;
  await writeForScope(record.scopeId ?? 'private', ['outbox'], t => {
    const store = t.objectStore('outbox');
    const held = store.getKey(record.id);
    held.onsuccess = () => {
      if (held.result === undefined) return;
      store.put(record);
      updated = true;
    };
  });
  return updated;
}

export async function hasOutboxRecord(id: string): Promise<boolean> {
  return (await tx('outbox', 'readonly', s => s.getKey(id))) !== undefined;
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
  await write(db, ['devices'], t => {
    const s = t.objectStore('devices');
    s.clear();
    for (const profile of profiles) s.put(profile);
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

/**
 * A setting kept on behalf of one scope (its member roster, its
 * notifications-primed flag). Not written for a chat that has left this
 * device: a pass can still be finishing when its chat is removed, and a
 * primed flag left behind would make a later re-join announce the chat's
 * whole history as new.
 */
export async function putScopeSetting(scopeId: ScopeId, key: string, value: unknown): Promise<void> {
  await writeForScope(scopeId, ['settings'], t => {
    t.objectStore('settings').put(value, key);
  });
}

export function deleteSetting(key: string): Promise<void> {
  return tx('settings', 'readwrite', s => { s.delete(key); });
}

/** Every setting whose key starts with `prefix`, as key/value pairs. */
export async function getSettingsByPrefix<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('settings', 'readonly');
    const store = t.objectStore('settings');
    const range = IDBKeyRange.bound(prefix, prefix + RANGE_CEIL);
    const keysReq = store.getAllKeys(range);
    const valuesReq = store.getAll(range);
    t.oncomplete = () => {
      const keys = keysReq.result as string[];
      const values = valuesReq.result as T[];
      resolve(keys.map((key, i) => ({ key, value: values[i] })));
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * Put and delete several settings in one transaction — atomic across tabs,
 * since IndexedDB serializes readwrite transactions on a store.
 */
export async function updateSettings(puts: Array<[string, unknown]>, deletes: string[]): Promise<void> {
  const db = await openDb();
  await write(db, ['settings'], t => {
    const store = t.objectStore('settings');
    for (const key of deletes) store.delete(key);
    for (const [key, value] of puts) store.put(value, key);
  });
}

/**
 * Read-modify-write one setting inside a single transaction, so a
 * concurrent writer in another tab can neither be clobbered nor clobber
 * us. `fn` returning undefined deletes the key.
 */
export async function patchSetting<T>(key: string, fn: (current: T | undefined) => T | undefined): Promise<void> {
  const db = await openDb();
  await write(db, ['settings'], t => {
    const store = t.objectStore('settings');
    const req = store.get(key) as IDBRequest<T | undefined>;
    req.onsuccess = () => {
      const next = fn(req.result);
      if (next === undefined) store.delete(key);
      else store.put(next, key);
    };
  });
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
  await write(db, ['drops', 'thumbs', 'blobs', 'outbox', 'settings', 'chats'], t => {
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
  });
}

/**
 * The local half of a re-sync from scratch: remove a scope's synced drops
 * and cached media plus the given settings (its sync markers), keeping its
 * outbox and chat record — and start a new epoch, which this page adopts.
 * Any other tab mid-sync is thereby cut off: its next commit is refused, so
 * it cannot put back a delta token that no longer matches what is stored.
 */
export async function resetScopeStore(scopeId: ScopeId, settingsKeys: string[]): Promise<void> {
  const db = await openDb();
  await write(db, ['drops', 'thumbs', 'blobs', 'settings'], t => {
    t.objectStore('drops').delete(scopeRange(scopeId));
    t.objectStore('thumbs').delete(mediaRange(scopeId));
    t.objectStore('blobs').delete(mediaRange(scopeId));
    for (const key of settingsKeys) t.objectStore('settings').delete(key);
    renewEpoch(t, true);
  });
}

/** Every store, for the two operations that empty the database. */
const ALL_STORES = ['drops', 'thumbs', 'blobs', 'outbox', 'devices', 'chats', 'settings'];

/**
 * Wipe all local data (sign-out) and start a new epoch. This page does not
 * adopt it: from here on its own late writes — and those of every other tab
 * still open on the old account — are refused, so nothing of that account
 * can land after the wipe. The page is on its way out (or reloads).
 *
 * `settings` are written into the emptied store in the same transaction:
 * the marker saying the store was emptied on purpose.
 */
export async function clearAllData(opts: { settings?: Array<[string, unknown]> } = {}): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(ALL_STORES, 'readwrite');
    for (const s of ALL_STORES) t.objectStore(s).clear();
    renewEpoch(t, false);
    for (const [key, value] of opts.settings ?? []) t.objectStore('settings').put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * A page entering the app claims the store for `owner`, in one transaction:
 * - already marked as `owner`'s: kept ('kept');
 * - no marker at all: marked, data untouched ('adopted');
 * - marked as anything else: emptied, a new epoch started, marked as
 *   `owner`'s ('wiped'). Settings named in `carry` survive the wipe when
 *   `shouldCarry` says so.
 *
 * Reading the marker and acting on it in the same transaction is what makes
 * two pages entering at once safe: the second finds the store already its
 * own and keeps it, where two separate wipes would leave the first page on
 * a superseded epoch. Either way the page ends up on the store's current
 * epoch — it has read nothing else yet, so there is nothing stale to protect.
 */
export async function claimStore(
  ownerKey: string,
  owner: string,
  carry: string[] = [],
  shouldCarry: (key: string, value: unknown) => boolean = () => true,
): Promise<'kept' | 'adopted' | 'wiped'> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(ALL_STORES, 'readwrite');
    const settings = t.objectStore('settings');
    let outcome: 'kept' | 'adopted' | 'wiped' = 'kept';
    const epochAtOpen = pageEpoch;
    const marker = settings.get(ownerKey);
    const epoch = settings.get(EPOCH_KEY);
    const carried: Array<[string, unknown]> = [];
    for (const key of carry) {
      const held = settings.get(key);
      held.onsuccess = () => {
        if (held.result !== undefined && shouldCarry(key, held.result)) carried.push([key, held.result]);
      };
    }
    // Requests settle in the order they were made, so by the time this last
    // read comes back every one above has.
    const decide = settings.get(ownerKey);
    decide.onsuccess = () => {
      if (marker.result === owner || marker.result === undefined) {
        pageEpoch = (epoch.result as string | undefined) ?? null;
        if (marker.result === undefined) {
          outcome = 'adopted';
          settings.put(owner, ownerKey);
        }
        return;
      }
      outcome = 'wiped';
      for (const s of ALL_STORES) t.objectStore(s).clear();
      renewEpoch(t, true);
      settings.put(owner, ownerKey);
      for (const [key, value] of carried) settings.put(value, key);
    };
    t.oncomplete = () => resolve(outcome);
    t.onerror = () => reject(t.error);
    t.onabort = () => {
      if (outcome !== 'wiped') pageEpoch = epochAtOpen; // renewEpoch undoes its own
      reject(t.error);
    };
  });
}
