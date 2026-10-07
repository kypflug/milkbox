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

import type { ChatRecord, DeviceProfile, DropMeta, DropRecord, OutboxRecord, ScopeId, ScopeRef } from '../types';

const DB_NAME = 'milkbox-db';
/**
 * v4 changes no store. It is there to cut off pages still running a build
 * from before the store epoch (below), which would write behind a sign-out
 * or a re-sync: opening v4 closes their connections, and a build that asks
 * for v3 can never open the database again.
 *
 * That cuts both ways. A device that has opened v4 cannot run an older build:
 * rolling a deployment back past this version leaves it unable to open its
 * store until a build that knows v4 is deployed again.
 */
const DB_VERSION = 4;

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
 * is held on this device in the same stay the writer started under, checked
 * in the same transaction: work that outlives a leave or delete — an outbox
 * drain mid-retry, a sync batch, a preview finishing its download, in this
 * tab or another — must not put rows back under the scope that was just
 * cleared, nor into the same chat joined again since. Presence alone would
 * not tell those two stays apart; the record's generation does. Resolves
 * false when the write was skipped.
 */
async function writeForScope(
  ref: ScopeRef,
  stores: string[],
  body: (t: IDBTransaction) => void,
): Promise<boolean> {
  const db = await openDb();
  const chatId = ref.scopeId.startsWith('chat:') ? ref.scopeId.slice(5) : null;
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
    const chat = t.objectStore('chats').get(chatId) as IDBRequest<ChatRecord | undefined>;
    chat.onsuccess = () => {
      if (chat.result && chat.result.generation === ref.generation) apply();
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

/** Store one drop. Resolves false, writing nothing, when `ref` is not the stay held (see writeForScope). */
export function putDrop(ref: ScopeRef, record: DropRecord): Promise<boolean> {
  return writeForScope(ref, ['drops'], t => {
    t.objectStore('drops').put({ ...record, scopeId: ref.scopeId } satisfies StoredDropRecord);
  });
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
  /**
   * What this device held when the pass that downloaded `puts` took its
   * snapshot: drop id → eTag. With it, a put is made only where the stored
   * copy is still as the snapshot had it (the same eTag, or absent in both).
   *
   * Anything else means something happened to the drop here while the pass
   * was holding its body: the user deleted or edited it and OneDrive has
   * answered (the outbox drain stores the outcome at once), or another tab
   * stored it. The body in hand was listed before that, or after it, and
   * eTags do not say which. So it is not stored — it is left out — unless
   * the copy held is that very version already.
   *
   * A commit that leaves anything out also withholds `settingsPut` and
   * `settingsDelete`, the pass's position. Stored, the position would rule
   * the drop out of every later incremental pass, whichever version was the
   * later one. Withheld, the pass goes round again (see runScopeSync): the
   * same changes are listed anew against what is held by then, and what
   * OneDrive has at that point is what ends up stored.
   *
   * What this does not see: a drop the snapshot did not have, stored and
   * then deleted here while the pass ran. It reads as absent in both, so
   * the body in hand is stored, as it always was, until the next pass lists
   * the removal. And only puts are decided this way: `deletes` are applied
   * as they are.
   */
  snapshot?: ReadonlyMap<string, string | undefined>;
  /** Drop ids to remove, with their cached thumbnails and image bytes. */
  deletes?: string[];
  /** Settings written alongside — a pass's delta token and cTag. */
  settingsPut?: Array<[string, unknown]>;
  settingsDelete?: string[];
  /**
   * The ids among `puts` that someone else sent. Those this device turns out
   * not to have held are added, in this same transaction, to the scope's
   * list of unsettled arrivals (arrivalsKey): the drops still to be counted
   * unread and announced. Kept with the commit because the pass that brings
   * them in may never reach its end (a page iOS kills mid-pass), and the
   * next pass skips them by eTag — nothing else would ever count them.
   */
  arrivalCandidates?: ReadonlySet<string>;
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
  /**
   * Ids among `puts` for which this commit issued a put. Under a snapshot
   * (see DropCommit.snapshot) that excludes the ones it left out, and the
   * ones something else — another tab, or this tab's outbox drain — brought
   * to the very version it was handed since the snapshot: a commit can be
   * handed drops and write none of them. With no snapshot every put is
   * written, whatever is held.
   */
  landed: Set<string>;
  /** Ids among `deletes` that were stored when this commit removed them. */
  removed: Set<string>;
  /**
   * Ids among `puts` that were not stored, because the copy held had changed
   * since the pass's snapshot (see DropCommit.snapshot). When there are any,
   * the commit's settings were not written either.
   */
  leftOut: Set<string>;
}

/**
 * Apply changes to one scope's drops in a single transaction — a sync
 * pass's, so the delta token and cTag can never be stored without the drops
 * they describe (a killed app would otherwise resume past drops it never
 * wrote), or the local half of a delete that has just been sent.
 *
 * Puts land before deletes; a put may be left out, and the settings with it
 * (see DropCommit.snapshot). For a chat scope the write is skipped entirely
 * unless the chat is still held in the stay `ref` names (see writeForScope):
 * work that outlived a leave must neither write drops back under the
 * cleared scope nor remove them from the chat joined again since.
 */
export async function commitDropChanges(ref: ScopeRef, commit: DropCommit): Promise<DropCommitResult> {
  const { scopeId } = ref;
  const added = new Set<string>();
  const landed = new Set<string>();
  const removed = new Set<string>();
  const leftOut = new Set<string>();
  const { snapshot } = commit;
  const written = await writeForScope(ref, ['drops', 'thumbs', 'blobs', 'settings'], t => {
    const drops = t.objectStore('drops');
    // Everything but the puts. Issued once every put has been decided: it is
    // requested after them, as it always was, and by then it is known
    // whether the settings go in at all.
    const theRest = () => {
      for (const id of commit.deletes ?? []) {
        const there = drops.getKey([scopeId, id]);
        there.onsuccess = () => {
          if (there.result !== undefined) removed.add(id);
        };
        drops.delete([scopeId, id]);
        t.objectStore('thumbs').delete(mediaKey(scopeId, id));
        t.objectStore('blobs').delete(mediaKey(scopeId, id));
      }
      const settings = t.objectStore('settings');
      if (!leftOut.size) {
        for (const [key, value] of commit.settingsPut ?? []) settings.put(value, key);
        for (const key of commit.settingsDelete ?? []) settings.delete(key);
      }
      const candidates = commit.arrivalCandidates;
      if (candidates?.size) {
        const key = arrivalsKey(scopeId);
        const unsettled = settings.get(key) as IDBRequest<string[] | undefined>;
        unsettled.onsuccess = () => {
          const arrived = [...added].filter(id => candidates.has(id));
          if (arrived.length) settings.put([...(unsettled.result ?? []), ...arrived], key);
        };
      }
    };
    const puts = commit.puts ?? [];
    let undecided = puts.length;
    if (!undecided) theRest();
    for (const r of puts) {
      const id = r.meta.id;
      const held = drops.get([scopeId, id]) as IDBRequest<StoredDropRecord | undefined>;
      held.onsuccess = () => {
        const stored = held.result;
        const asSnapshot =
          !snapshot || (stored ? snapshot.has(id) && snapshot.get(id) === stored.eTag : !snapshot.has(id));
        if (asSnapshot) {
          if (!stored) added.add(id);
          drops.put({ ...r, scopeId } satisfies StoredDropRecord);
          landed.add(id);
        } else if (!(stored && stored.eTag !== undefined && stored.eTag === r.eTag)) {
          // Changed here since the snapshot, and not to this very version.
          leftOut.add(id);
        }
        if (--undecided === 0) theRest();
      };
    }
  });
  return { written, added, landed, removed, leftOut };
}

/** Where a scope keeps its unsettled arrivals (see DropCommit.arrivalCandidates). */
export function arrivalsKey(scopeId: ScopeId): string {
  return `milkbox:arrivals:${scopeId}`;
}

/** Those of a scope's unsettled arrivals that its feed has shown (see markArrivalsShown). */
export function shownArrivalsKey(scopeId: ScopeId): string {
  return `milkbox:arrivals-shown:${scopeId}`;
}

/**
 * Take a scope's unsettled arrivals for counting and announcing. The list is
 * emptied and — for a chat, when `countUnread` is set — the number of them
 * that are still stored and that its feed has not shown is added to the
 * chat's unread count, all in one transaction: a page killed here neither
 * loses the count nor applies it twice. Resolves the ids taken, shown ones
 * included; none when `ref` is not the stay held.
 */
export async function takeArrivals(ref: ScopeRef, countUnread: boolean): Promise<string[]> {
  const chatId = ref.scopeId.startsWith('chat:') ? ref.scopeId.slice(5) : null;
  const key = arrivalsKey(ref.scopeId);
  const shownKey = shownArrivalsKey(ref.scopeId);
  let taken: string[] = [];
  await writeForScope(ref, ['settings', 'drops'], t => {
    const settings = t.objectStore('settings');
    const unsettled = settings.get(key) as IDBRequest<string[] | undefined>;
    unsettled.onsuccess = () => {
      const ids = unsettled.result ?? [];
      if (!ids.length) return;
      settings.delete(key);
      taken = ids;
      const shown = settings.get(shownKey) as IDBRequest<string[] | undefined>;
      shown.onsuccess = () => {
        settings.delete(shownKey);
        if (!chatId || !countUnread) return;
        const seen = new Set(shown.result ?? []);
        // A set: an id that came to be listed twice counts once.
        const notShown = new Set(ids.filter(id => !seen.has(id)));
        if (!notShown.size) return;
        // As stored now, like the announcement: an arrival that has been
        // removed since (a later commit deleted it) is not unread.
        const stored = t.objectStore('drops').getAllKeys(scopeRange(ref.scopeId)) as IDBRequest<IDBValidKey[]>;
        stored.onsuccess = () => {
          const unread = (stored.result as Array<[ScopeId, string]>).filter(([, id]) => notShown.has(id)).length;
          if (!unread) return;
          const chats = t.objectStore('chats');
          const held = chats.get(chatId) as IDBRequest<ChatRecord | undefined>;
          held.onsuccess = () => {
            const chat = held.result;
            if (chat) chats.put({ ...chat, unreadCount: (chat.unreadCount ?? 0) + unread });
          };
        };
      };
    };
  });
  return taken;
}

/**
 * The scope's feed drew these drops while it was visible. Unsettled arrivals
 * among them are no longer unread, whenever they come to be settled.
 *
 * With `forget` they leave the list outright: the user was looking, and
 * there is nothing left to announce either. Without it they stay listed, to
 * be announced with the rest when the list is settled, and are only
 * remembered as shown. Arrivals the feed did not draw are untouched.
 */
export async function markArrivalsShown(ref: ScopeRef, drawn: ReadonlySet<string>, forget: boolean): Promise<void> {
  const key = arrivalsKey(ref.scopeId);
  const shownKey = shownArrivalsKey(ref.scopeId);
  await writeForScope(ref, ['settings'], t => {
    const settings = t.objectStore('settings');
    const unsettled = settings.get(key) as IDBRequest<string[] | undefined>;
    unsettled.onsuccess = () => {
      const ids = unsettled.result ?? [];
      if (!ids.some(id => drawn.has(id))) return;
      if (forget) {
        const rest = ids.filter(id => !drawn.has(id));
        if (rest.length) {
          settings.put(rest, key);
        } else {
          settings.delete(key);
          settings.delete(shownKey);
        }
        return;
      }
      const shown = settings.get(shownKey) as IDBRequest<string[] | undefined>;
      shown.onsuccess = () => {
        const seen = new Set(shown.result ?? []);
        const fresh = ids.filter(id => drawn.has(id) && !seen.has(id));
        if (fresh.length) settings.put([...seen, ...fresh], shownKey);
      };
    };
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

export async function putThumb(ref: ScopeRef, dropId: string, blob: Blob): Promise<void> {
  await writeForScope(ref, ['thumbs'], t => {
    t.objectStore('thumbs').put(blob, mediaKey(ref.scopeId, dropId));
  });
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
    // Touch lastAccess (fire-and-forget) on the entry as it is now, if it is
    // still there. Writing back the one read above would bring the image
    // back after its scope was cleared — or, if the chat has been joined
    // again and the image cached afresh, put the old bytes over the new.
    tx('blobs', 'readwrite', s => {
      const held = s.get(key) as IDBRequest<BlobEntry | undefined>;
      held.onsuccess = () => {
        if (held.result) s.put({ ...held.result, lastAccess: Date.now() });
      };
    }).catch(() => {});
    return entry.blob;
  }
  return undefined;
}

export async function putCachedBlob(ref: ScopeRef, dropId: string, blob: Blob): Promise<void> {
  await writeForScope(ref, ['blobs'], t => {
    t.objectStore('blobs').put(
      { id: mediaKey(ref.scopeId, dropId), blob, size: blob.size, lastAccess: Date.now() } satisfies BlobEntry,
    );
  });
  sweepBlobCache().catch(() => {});
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
 * Queue a record for the scope `ref` names. Resolves false, writing nothing,
 * for a chat that has left this device (or is no longer the stay `ref` was
 * resolved from).
 */
export function putOutboxRecord(ref: ScopeRef, record: OutboxRecord): Promise<boolean> {
  return writeForScope(ref, ['outbox'], t => {
    t.objectStore('outbox').put(record);
  });
}

/**
 * Queue an edit and show it at once: the outbox row that sends it and the
 * edited local copy, in one transaction. Resolves false, writing neither,
 * when `ref` is not the stay held; rejects, writing neither, when this
 * page's store has been superseded.
 *
 * One transaction because what the caller is told has to be what was
 * queued. As two writes, a re-sync in another tab between them (which
 * keeps the outbox and starts a new epoch) refused the second one after
 * the first had landed: the editor reported the edit as not saved, and
 * the row it had queued was sent all the same. (A chat left between them
 * was never that case: a leave takes the chat's outbox rows with it, so
 * that refusal was true. Here it is simply one answer.)
 *
 * The row keeps the server's version, and the eTag it was held at, for a
 * discard to restore. A second edit before the first lands inherits the
 * first one's original exactly — including none at all, if an older build
 * queued it. Both are read here, inside the transaction, so they are the
 * versions this edit replaces. A drop that is not stored gets no local
 * copy, only the row.
 */
export function queueEdit(ref: ScopeRef, meta: DropMeta): Promise<boolean> {
  return writeForScope(ref, ['outbox', 'drops'], t => {
    const outbox = t.objectStore('outbox');
    const drops = t.objectStore('drops');
    const queued = outbox.get(meta.id) as IDBRequest<OutboxRecord | undefined>;
    queued.onsuccess = () => {
      const stored = drops.get([ref.scopeId, meta.id]) as IDBRequest<StoredDropRecord | undefined>;
      stored.onsuccess = () => {
        const earlier = queued.result?.op === 'edit' ? queued.result : undefined;
        const held = stored.result;
        outbox.put({
          id: meta.id,
          meta,
          op: 'edit',
          attempts: 0,
          state: 'queued',
          scopeId: ref.scopeId,
          prevMeta: earlier ? earlier.prevMeta : held?.meta,
          prevETag: earlier ? earlier.prevETag : held?.eTag,
        } satisfies OutboxRecord);
        if (held) drops.put({ ...held, meta } satisfies StoredDropRecord);
      };
    };
  });
}

/**
 * Update a record that is still queued; resolves false, writing nothing,
 * when it no longer is. A drain can sit in a retry backoff for seconds: if
 * the send was cancelled meanwhile, or its chat removed (which deletes its
 * rows), the drain must find that out here — in any tab, and even if the
 * chat has been joined again since — and not put the row back.
 */
export async function updateOutboxRecord(ref: ScopeRef, record: OutboxRecord): Promise<boolean> {
  let updated = false;
  await writeForScope(ref, ['outbox'], t => {
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

export type DiscardOutcome = 'gone' | 'removed' | 'restored' | 'kept' | 'invalidated';

/**
 * Discard a queued record and, if it was an edit, undo what the edit left on
 * the local copy — one transaction, because the two must not come apart:
 * with the record gone and the optimistic text still stored under the
 * server's eTag, no sync pass would ever correct the drop.
 *
 * - 'restored' / 'kept': the edit kept the version it was made on
 *   (prevMeta). That version is put back — unless a pass has since stored a
 *   newer one (the eTag moved on), which is the server's truth and stays.
 * - 'invalidated': it kept none (it was queued by an older build). The
 *   drop's eTag is cleared, so it stops matching the server's, and the
 *   setting under `invalidateKey` — the scope's delta token — is deleted,
 *   so that the next pass enumerates everything and downloads the real
 *   version.
 * - 'removed': there was nothing to undo (not an edit, or no local copy).
 * - 'gone': no such record in this scope, or `ref` is not the stay held;
 *   nothing was touched.
 */
export async function discardOutboxRecord(ref: ScopeRef, id: string, invalidateKey: string): Promise<DiscardOutcome> {
  let outcome: DiscardOutcome = 'gone';
  await writeForScope(ref, ['outbox', 'drops', 'settings'], t => {
    const outbox = t.objectStore('outbox');
    const queued = outbox.get(id) as IDBRequest<OutboxRecord | undefined>;
    queued.onsuccess = () => {
      const record = queued.result;
      if (!record || (record.scopeId ?? 'private') !== ref.scopeId) return;
      outbox.delete(id);
      outcome = 'removed';
      if (record.op !== 'edit') return;
      const drops = t.objectStore('drops');
      const stored = drops.get([ref.scopeId, id]) as IDBRequest<StoredDropRecord | undefined>;
      stored.onsuccess = () => {
        const drop = stored.result;
        if (!drop) return;
        if (record.prevMeta) {
          if (drop.eTag !== record.prevETag) {
            outcome = 'kept';
            return;
          }
          drops.put({ ...drop, meta: record.prevMeta });
          outcome = 'restored';
        } else {
          drops.put({ ...drop, eTag: undefined });
          t.objectStore('settings').delete(invalidateKey);
          outcome = 'invalidated';
        }
      };
    };
  });
  return outcome;
}

export async function hasOutboxRecord(id: string): Promise<boolean> {
  return (await tx('outbox', 'readonly', s => s.getKey(id))) !== undefined;
}

export function deleteOutboxRecord(id: string): Promise<void> {
  return tx('outbox', 'readwrite', s => { s.delete(id); });
}

/**
 * Remove a record whose send has ended — from the stay the send was made
 * in, and no other. Rows are keyed by drop id: after a chat has been left
 * and joined again, the row under that id can be one the new stay queued
 * for the same drop, which an earlier stay's send must not take with it.
 * Resolves false when `ref` is not the stay held.
 */
export function removeOutboxRecord(ref: ScopeRef, id: string): Promise<boolean> {
  return writeForScope(ref, ['outbox'], t => {
    t.objectStore('outbox').delete(id);
  });
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

/**
 * Store a chat this device does not hold, stamped with a new generation —
 * the start of a stay. Resolves the record as stored, or null when the chat
 * is already held (a join and a discovery can race): that record, and the
 * stay it stands for, are left as they are.
 */
export async function addChat(record: ChatRecord): Promise<ChatRecord | null> {
  const db = await openDb();
  const stored: ChatRecord = { ...record, generation: crypto.randomUUID() };
  let added = false;
  await write(db, ['chats'], t => {
    const store = t.objectStore('chats');
    const held = store.getKey(record.id);
    held.onsuccess = () => {
      if (held.result !== undefined) return;
      store.put(stored);
      added = true;
    };
  });
  return added ? stored : null;
}

export function deleteChat(id: string): Promise<void> {
  return tx('chats', 'readwrite', s => { s.delete(id); });
}

/**
 * Read-modify-write a chat record in one transaction, so a chat removed
 * meanwhile is never put back by its own patch. Resolves false, writing
 * nothing, when the chat is not held.
 *
 * With `only`, also when the record is not the stay `only.generation` names:
 * for work started under an earlier one (a sync pass), which must not touch
 * a chat that has been joined again since.
 */
export async function patchChat(
  id: string,
  partial: Partial<Omit<ChatRecord, 'id' | 'generation'>>,
  only?: { generation: string | undefined },
): Promise<boolean> {
  const db = await openDb();
  let patched = false;
  await write(db, ['chats'], t => {
    const store = t.objectStore('chats');
    const held = store.get(id) as IDBRequest<ChatRecord | undefined>;
    held.onsuccess = () => {
      const existing = held.result;
      if (!existing || (only && existing.generation !== only.generation)) return;
      store.put({ ...existing, ...partial });
      patched = true;
    };
  });
  return patched;
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
export async function putScopeSetting(ref: ScopeRef, key: string, value: unknown): Promise<void> {
  await writeForScope(ref, ['settings'], t => {
    t.objectStore('settings').put(value, key);
  });
}

/**
 * Read a scope setting and write what `update` makes of it, in the one
 * transaction (and only for the stay `ref` names, as putScopeSetting). Two
 * callers moving the same setting at once cannot each read the value from
 * before the other and write the other's change away. `update` is given
 * undefined when nothing is stored; returning undefined writes nothing.
 */
export async function updateScopeSetting<T>(
  ref: ScopeRef,
  key: string,
  update: (current: T | undefined) => T | undefined,
): Promise<void> {
  await writeForScope(ref, ['settings'], t => {
    const settings = t.objectStore('settings');
    const current = settings.get(key) as IDBRequest<T | undefined>;
    current.onsuccess = () => {
      const next = update(current.result);
      if (next !== undefined) settings.put(next, key);
    };
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
    arrivalsKey(scopeId),
    shownArrivalsKey(scopeId),
  ];
}

/**
 * Remove everything a scope owns locally (leave chat / chat gone / delete).
 *
 * With `only`, a chat is cleared only while the record held is still the
 * stay `only.generation` names: for a removal decided from an earlier
 * reading (the registry pass lists OneDrive first, a leave reads the record
 * and then waits), which must not take a chat that has been left and joined
 * again since. Resolves false when nothing was cleared for that reason.
 *
 * `alongside` is settings written in the same transaction, and only if the
 * scope is cleared: what a leave queues for OneDrive, so that a leave which
 * turns out to be for an earlier stay queues nothing against the later one.
 */
export async function clearScopeData(
  scopeId: ScopeId,
  only?: { generation: string | undefined },
  alongside?: { puts: Array<[string, unknown]>; deletes: string[] },
): Promise<boolean> {
  const db = await openDb();
  const chatId = scopeId.startsWith('chat:') ? scopeId.slice(5) : null;
  let cleared = false;
  await write(db, ['drops', 'thumbs', 'blobs', 'outbox', 'settings', 'chats'], t => {
    const clear = () => {
      t.objectStore('drops').delete(scopeRange(scopeId));
      t.objectStore('thumbs').delete(mediaRange(scopeId));
      t.objectStore('blobs').delete(mediaRange(scopeId));
      const settings = t.objectStore('settings');
      for (const key of scopeSettingsKeys(scopeId)) settings.delete(key);
      for (const key of alongside?.deletes ?? []) settings.delete(key);
      for (const [key, value] of alongside?.puts ?? []) settings.put(value, key);
      if (chatId) t.objectStore('chats').delete(chatId);
      const outboxStore = t.objectStore('outbox');
      const req = outboxStore.getAll() as IDBRequest<OutboxRecord[]>;
      req.onsuccess = () => {
        for (const record of req.result) {
          if ((record.scopeId ?? 'private') === scopeId) outboxStore.delete(record.id);
        }
      };
      cleared = true;
    };
    if (!only || !chatId) {
      clear();
      return;
    }
    const held = t.objectStore('chats').get(chatId) as IDBRequest<ChatRecord | undefined>;
    held.onsuccess = () => {
      if (held.result && held.result.generation === only.generation) clear();
    };
  });
  return cleared;
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
 * adopt it: once the wipe commits its own late writes — and those of every
 * other tab that had already opened the store — are refused, so nothing they
 * were still holding of that account can land after the wipe. The page is on
 * its way out (or reloads).
 *
 * `settings` are written into the emptied store in the same transaction:
 * the marker saying the store was emptied on purpose.
 *
 * With `timeoutMs` the wipe is given up on at that limit and rejects. Its
 * transaction is aborted where it still can be, and one not yet opened never
 * is: the store keeps its contents and its epoch, and nothing is refused. A
 * transaction already committing cannot be aborted and lands after all — but
 * it holds every store until it does, so it lands over exactly what it
 * started on, never over anything written since.
 */
export async function clearAllData(
  opts: { settings?: Array<[string, unknown]>; timeoutMs?: number } = {},
): Promise<void> {
  let t: IDBTransaction | null = null;
  let gaveUp = false;
  const wipe = (async () => {
    const db = await openDb();
    if (gaveUp) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ALL_STORES, 'readwrite');
      t = tx;
      for (const s of ALL_STORES) tx.objectStore(s).clear();
      renewEpoch(tx, false);
      for (const [key, value] of opts.settings ?? []) tx.objectStore('settings').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  })();
  if (!opts.timeoutMs) return wipe;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      gaveUp = true;
      try {
        t?.abort();
      } catch {
        // already committing, or done
      }
      reject(new Error('Clearing local data timed out'));
    }, opts.timeoutMs);
  });
  wipe.catch(() => {}); // the abort above settles it after the race is over
  try {
    await Promise.race([wipe, limit]);
  } finally {
    clearTimeout(timer);
  }
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
