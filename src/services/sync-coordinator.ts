/**
 * Sync coordinator — the single owner of sync and outbox state, for every
 * scope: the private feed plus any number of shared chats.
 *
 * Responsibilities:
 * - Serialized sync passes per scope (never two delta runs for one scope)
 * - A persistent outbox: optimistic sends that survive reloads, with
 *   exponential backoff and Retry-After handling, stamped with their scope
 * - Feed assembly: IDB drops + pending outbox overlays, per scope
 * - The chat registry: create/join/leave/delete, roaming hydration, unread
 * - Event pub/sub — the UI subscribes; this module never touches the DOM
 */

import {
  PRIVATE_SCOPE,
  PRIVATE_SCOPE_ID,
  scopeIdOf,
  type AuthorAttribution,
  type ChatRecord,
  type ChatScope,
  type DeviceProfile,
  type DropMeta,
  type DropRecord,
  type OutboxRecord,
  type Scope,
  type ScopeId,
} from '../types';
import * as db from './db';
import * as graph from './graph';
import * as chatsApi from './chats';
import * as device from './device';
import * as notify from './notify';
import { ConsentRequiredError } from './auth';
import { postBroadcast } from './broadcast';
import { errorLabel, newPassCounts, recordPass, requestCount, type PassStats } from './sync-stats';
import {
  deferRegistryOp,
  enqueueRegistryOp,
  getRegistryOutbox,
  hasPendingRegistryOp,
  removeRegistryOp,
  type RegistryOp,
} from './registry-outbox';

export type CoordinatorEvent =
  | { type: 'sync-start'; scopeId: ScopeId }
  | { type: 'sync-complete'; scopeId: ScopeId }
  | { type: 'sync-error'; scopeId: ScopeId; error: unknown }
  /** A pass is fetching drops: `received` of the `total` it set out to download. */
  | { type: 'sync-progress'; scopeId: ScopeId; received: number; total: number }
  | { type: 'feed-updated'; scopeId: ScopeId }
  | { type: 'drop-progress'; scopeId: ScopeId; dropId: string; fraction: number }
  /** A queued chat edit lost its conditional write — the drop changed or was removed remotely. */
  | { type: 'drop-conflict'; scopeId: ScopeId; dropId: string }
  | { type: 'chats-changed' }
  /** A chat left the local registry because the account left or deleted it on another device. */
  | { type: 'chat-removed'; chatId: string; name: string };

type Handler = (event: CoordinatorEvent) => void;

const handlers = new Set<Handler>();
const PENDING_DEVICE_PROFILE_KEY = 'milkbox:pending-device-profile';
const ME_KEY = 'milkbox:me';
const ACTIVE_SCOPE_KEY = 'milkbox:active-scope';
/** Set once a scope's first sync pass lands, so a join/sign-in isn't announced. */
const notifyPrimedKey = (scopeId: ScopeId) => `milkbox:notify-primed:${scopeId}`;
const membersKey = (scopeId: ScopeId) => `milkbox:members:${scopeId}`;

export function onCoordinatorEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function emit(event: CoordinatorEvent): void {
  for (const h of handlers) h(event);
}

// ─── identity ───

let mePromise: Promise<AuthorAttribution | null> | null = null;

/**
 * The signed-in person, cached in IDB. Null while it has never been
 * fetchable (first run offline) — private sends proceed without an author;
 * chat sends require it.
 */
export function ensureMe(): Promise<AuthorAttribution | null> {
  if (mePromise) return mePromise;
  mePromise = (async () => {
    const cached = await db.getSetting<AuthorAttribution>(ME_KEY);
    if (cached) return cached;
    try {
      const me = await chatsApi.getMe();
      await db.putSetting(ME_KEY, me);
      return me;
    } catch (err) {
      console.debug('[Sync] Could not fetch /me yet:', err);
      mePromise = null; // retry on the next caller
      return null;
    }
  })();
  return mePromise;
}

// ─── scopes ───

export function chatScopeOf(record: ChatRecord): ChatScope {
  return {
    kind: 'chat',
    chatId: record.id,
    name: record.name,
    role: record.role,
    driveId: record.driveId,
    itemId: record.itemId,
    dropsItemId: record.dropsItemId,
    host: record.host,
  };
}

export async function resolveScope(scopeId: ScopeId): Promise<Scope | null> {
  if (scopeId === PRIVATE_SCOPE_ID) return PRIVATE_SCOPE;
  if (!scopeId.startsWith('chat:')) return null;
  const record = await db.getChat(scopeId.slice(5));
  return record ? chatScopeOf(record) : null;
}

export async function getActiveScopeId(): Promise<ScopeId> {
  const saved = await db.getSetting<ScopeId>(ACTIVE_SCOPE_KEY);
  if (!saved) return PRIVATE_SCOPE_ID;
  // A stale pointer at a since-removed chat falls back to private.
  return (await resolveScope(saved)) ? saved : PRIVATE_SCOPE_ID;
}

export function setActiveScopeId(scopeId: ScopeId): Promise<void> {
  return db.putSetting(ACTIVE_SCOPE_KEY, scopeId);
}

// ─── feed assembly ───

/**
 * The rendered feed for one scope: synced drops from IDB with pending outbox
 * records overlaid (an outbox create shows as 'sending'/'failed'; an outbox
 * delete hides the drop before the server confirms). Sorted by ULID.
 */
export async function loadFeed(scopeId: ScopeId): Promise<DropRecord[]> {
  const [drops, outbox] = await Promise.all([db.getScopeDrops(scopeId), db.getOutbox()]);
  const byId = new Map<string, DropRecord>();
  for (const d of drops) byId.set(d.meta.id, { ...d, state: undefined });
  for (const o of outbox) {
    if ((o.scopeId ?? PRIVATE_SCOPE_ID) !== scopeId) continue;
    if (o.op === 'delete') {
      byId.delete(o.id);
    } else {
      byId.set(o.id, {
        meta: o.meta,
        state: o.state === 'failed' ? 'failed' : 'sending',
      });
    }
  }
  return [...byId.values()].sort((a, b) => (a.meta.id < b.meta.id ? -1 : 1));
}

async function ensureCurrentDeviceProfile(): Promise<DeviceProfile> {
  const current = device.getDeviceProfile();
  const cached = await db.getDeviceProfile(current.id);
  if (
    !cached ||
    cached.name !== current.name ||
    cached.os !== current.os ||
    cached.updatedAt !== current.updatedAt
  ) {
    await db.putDeviceProfile(current);
    await db.putSetting(PENDING_DEVICE_PROFILE_KEY, current);
  }
  return current;
}

export async function loadDeviceProfiles(): Promise<DeviceProfile[]> {
  await ensureCurrentDeviceProfile();
  return db.getAllDeviceProfiles();
}

export async function renameCurrentDevice(name: string): Promise<void> {
  const profile = device.setDeviceName(name);
  await db.putDeviceProfile(profile);
  await db.putSetting(PENDING_DEVICE_PROFILE_KEY, profile);
  emit({ type: 'feed-updated', scopeId: PRIVATE_SCOPE_ID });
  void requestSync(PRIVATE_SCOPE, { force: true });
}

// ─── outbox ───

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

/** Queue a new drop (optionally with a file payload) and start draining. */
export async function enqueueCreate(scope: Scope, meta: DropMeta, blob?: Blob): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const me = await ensureMe();
  if (scope.kind === 'chat' && !me) {
    throw new Error('Cannot send to a chat before your Microsoft profile has loaded — check your connection.');
  }
  const stamped: DropMeta = me ? { ...meta, author: me } : meta;
  await db.putOutboxRecord({
    id: stamped.id,
    meta: stamped,
    blob,
    op: 'create',
    attempts: 0,
    state: 'queued',
    scopeId,
  });
  emit({ type: 'feed-updated', scopeId });
  // Upload now, even if a long pass (a first sync) is mid-download; the
  // forced pass then picks up anything else that changed.
  void drainOutbox(scopeId);
  void requestSync(scope, { force: true });
}

/** Queue an edit to an existing text drop. */
export async function enqueueEdit(scope: Scope, meta: DropMeta): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const existing = await db.getDrop(scopeId, meta.id);
  // Keep the server's version, and the eTag it was held at, for a discard to
  // restore. A second edit before the first lands inherits the first one's
  // original exactly — including none at all, if an older build queued it.
  const queued = (await db.getOutbox()).find(r => r.id === meta.id && r.op === 'edit');
  const prevMeta = queued ? queued.prevMeta : existing?.meta;
  const prevETag = queued ? queued.prevETag : existing?.eTag;
  await db.putOutboxRecord({
    id: meta.id,
    meta,
    op: 'edit',
    attempts: 0,
    state: 'queued',
    scopeId,
    prevMeta,
    prevETag,
  });
  // Optimistically update the local record so the edit shows immediately
  if (existing) await db.putDrop(scopeId, { ...existing, meta });
  emit({ type: 'feed-updated', scopeId });
  void drainOutbox(scopeId);
}

/** Queue a delete. The feed hides the drop immediately. */
export async function enqueueDelete(scope: Scope, id: string): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const existing = await db.getDrop(scopeId, id);
  const meta = existing?.meta;
  if (!meta) {
    // Drop only exists in the outbox (never synced) — just cancel it
    await db.deleteOutboxRecord(id);
    emit({ type: 'feed-updated', scopeId });
    return;
  }
  await db.putOutboxRecord({ id, meta, op: 'delete', attempts: 0, state: 'queued', scopeId });
  emit({ type: 'feed-updated', scopeId });
  void drainOutbox(scopeId);
}

/** Retry a failed outbox record. */
export async function retryOutboxRecord(id: string): Promise<void> {
  const records = await db.getOutbox();
  const record = records.find(r => r.id === id);
  if (!record) return;
  const scopeId = record.scopeId ?? PRIVATE_SCOPE_ID;
  await db.putOutboxRecord({ ...record, attempts: 0, state: 'queued' });
  emit({ type: 'feed-updated', scopeId });
  void drainOutbox(scopeId);
}

/** Discard a failed outbox record entirely. */
export async function discardOutboxRecord(id: string): Promise<void> {
  const records = await db.getOutbox();
  const record = records.find(r => r.id === id);
  await db.deleteOutboxRecord(id);
  const scopeId = record?.scopeId ?? PRIVATE_SCOPE_ID;
  // A discarded edit never reached OneDrive: put the server's version back
  // over the optimistic local copy. Its eTag still matches the server's, so
  // no sync pass would ever correct it.
  const existing = record?.op === 'edit' ? await db.getDrop(scopeId, id) : undefined;
  if (existing && record?.prevMeta) {
    // Only while the row is still the version the edit was made on. If a
    // pass has since brought a newer one (another device edited the drop
    // while this edit sat failed), that is the server's truth: leave it.
    if (existing.eTag === record.prevETag) {
      await db.putDrop(scopeId, { ...existing, meta: record.prevMeta });
    }
  } else if (existing) {
    // An edit queued by an older build kept no original to restore. Forget
    // the row's eTag, so it stops matching the server's, and make the next
    // pass enumerate everything: that pass downloads the real version (or
    // sweeps the drop if it is gone). The token is cleared as well so the
    // full pass still happens if the app closes first; the flag covers a
    // pass already running, whose commit would put a token back.
    await db.putDrop(scopeId, { ...existing, eTag: undefined });
    const scope = await resolveScope(scopeId);
    if (scope) {
      stateFor(scopeId).forceFull = true;
      await graph.clearDeltaToken(scope);
      void requestSync(scope, { force: true });
    }
  }
  emit({ type: 'feed-updated', scopeId });
}

const drainingScopes = new Set<ScopeId>();
/** Asked to drain while a drain was running — go round once more. */
const drainAgainScopes = new Set<ScopeId>();

/**
 * Drain one scope's outbox serially. Each record gets MAX_ATTEMPTS tries with
 * exponential backoff; throttle responses (429/503) pause the whole drain
 * for the server-requested interval. A send queued mid-drain is picked up by
 * the same drain rather than waiting for the next pass.
 */
export async function drainOutbox(scopeId: ScopeId): Promise<void> {
  if (drainingScopes.has(scopeId)) {
    drainAgainScopes.add(scopeId);
    return;
  }
  drainingScopes.add(scopeId);
  try {
    do {
      drainAgainScopes.delete(scopeId);
      const scope = await resolveScope(scopeId);
      const records = (await db.getOutbox()).filter(r => (r.scopeId ?? PRIVATE_SCOPE_ID) === scopeId);
      // Oldest first so the feed lands in order
      records.sort((a, b) => (a.id < b.id ? -1 : 1));

      for (const record of records) {
        if (record.state === 'failed') continue;
        if (!scope) {
          // The chat is no longer registered locally — terminal.
          await db.putOutboxRecord({ ...record, state: 'failed' });
          continue;
        }
        await processOutboxRecord(scope, record);
      }
    } while (drainAgainScopes.has(scopeId));
  } finally {
    drainingScopes.delete(scopeId);
    drainAgainScopes.delete(scopeId);
  }
}

async function processOutboxRecord(scope: Scope, record: OutboxRecord): Promise<void> {
  const scopeId = scopeIdOf(scope);
  let attempts = record.attempts;
  while (attempts < MAX_ATTEMPTS) {
    try {
      // Mutate the in-memory record before persisting: performOp's
      // onSessionCreated later persists { ...record }, so a stale copy here
      // would revert the row's attempts/state mid-flight.
      record.attempts = attempts;
      record.state = 'sending';
      await db.putOutboxRecord({ ...record });
      await performOp(scope, record);
      await db.deleteOutboxRecord(record.id);
      emit({ type: 'feed-updated', scopeId });
      postBroadcast({
        type: 'drop-mutated',
        dropId: record.id,
        action: record.op === 'delete' ? 'delete' : 'upsert',
        scopeId,
      });
      return;
    } catch (err) {
      if (err instanceof graph.DropConflictError) {
        // The drop changed or was removed remotely — never retry (a retry
        // would resurrect what another member deleted). Remote wins; the
        // next sync pass reconciles the local record.
        await db.deleteOutboxRecord(record.id);
        emit({ type: 'drop-conflict', scopeId, dropId: record.id });
        emit({ type: 'feed-updated', scopeId });
        return;
      }
      attempts++;
      const throttled = graph.isThrottleError(err);
      const retryAfter =
        throttled && err instanceof graph.GraphHttpError && err.retryAfterSeconds
          ? err.retryAfterSeconds * 1000
          : BACKOFF_BASE_MS * 2 ** (attempts - 1);
      if (throttled) noteThrottle(err);
      console.warn('[Outbox] %s %s failed (attempt %d):', record.op, record.id, attempts, err);
      if (attempts >= MAX_ATTEMPTS) {
        record.attempts = attempts;
        record.state = 'failed';
        await db.putOutboxRecord({ ...record });
        emit({ type: 'feed-updated', scopeId });
        return;
      }
      await new Promise(r => setTimeout(r, retryAfter));
    }
  }
}

async function performOp(scope: Scope, record: OutboxRecord): Promise<void> {
  const scopeId = scopeIdOf(scope);
  if (record.op === 'delete') {
    await graph.deleteDropJson(scope, record.id);
    if (record.meta.file) await graph.deleteDropFiles(scope, record.id);
    await db.deleteDrop(scopeId, record.id);
    await db.deleteThumb(scopeId, record.id).catch(() => {});
    await db.deleteCachedBlob(scopeId, record.id).catch(() => {});
    return;
  }

  const meta = { ...record.meta };

  if (record.op === 'create' && meta.file && record.blob) {
    // Blob first, then JSON — other devices never see a dangling reference
    const uploaded = await graph.uploadDropFile(scope, meta, record.blob, {
      existingSessionUrl: record.uploadUrl,
      onSessionCreated: uploadUrl => {
        // Persist so a reloaded tab resumes instead of restarting — and keep
        // the in-memory record in step, or a retry's state write would
        // clobber the session URL and restart the upload from byte zero.
        record.uploadUrl = uploadUrl;
        void db.putOutboxRecord({ ...record });
      },
      onProgress: fraction => emit({ type: 'drop-progress', scopeId, dropId: meta.id, fraction }),
    });
    meta.file = { ...meta.file, itemId: uploaded.itemId };
  }

  const existing = record.op === 'edit' ? await db.getDrop(scopeId, meta.id) : undefined;
  const eTag = await graph.putDropJson(scope, meta, existing?.eTag);
  await db.putDrop(scopeId, { meta, eTag });

  // Cache the local payload as the image blob so the sender gets an
  // instant render without a round-trip
  if (meta.kind === 'image' && record.blob) {
    await db.putCachedBlob(scopeId, meta.id, record.blob).catch(() => {});
  }
}

// ─── sync ───

interface ScopeSyncState {
  syncing: boolean;
  syncPromise: Promise<void> | null;
  syncAgain: boolean;
  lastSyncAt: number;
  consecutiveGone: number;
  lastMembersFetch: number;
  lastDescriptorFetch: number;
  /** A pass finished this session — the feed's "fetching" copy can go. */
  completedOnce: boolean;
  /** Aborts the running pass (a reset, or sign-out). */
  controller: AbortController | null;
  /** The next pass ignores its delta token and enumerates the whole scope. */
  forceFull: boolean;
  /** The last pass ended in an error — coming back to the app tries again. */
  lastPassFailed: boolean;
  /** Quick retries spent since the last completed pass. */
  retryCount: number;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

const scopeStates = new Map<ScopeId, ScopeSyncState>();
const SYNC_FLOOR_MS = 5_000;
const MEMBERS_REFRESH_MS = 5 * 60_000;
const GONE_THRESHOLD = 3;
/** After a transient failure, try again this soon; then the 45 s poll takes over. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
/** Other tabs re-read the feed at most this often while a pass commits batches. */
const BROADCAST_EVERY_MS = 2_000;

/** Sign-out has begun: no new passes, and every write is refused. */
let shuttingDown = false;

/** Global throttle gate — Graph throttles per app+user across all drives,
 *  so one 429 pauses every scope's polling and syncing. */
let throttledUntil = 0;

/** Raise the gate on a 429/503 — thumbnail loads report theirs here too. */
export function noteThrottle(err: unknown): void {
  if (!graph.isThrottleError(err)) return;
  const seconds = err instanceof graph.GraphHttpError && err.retryAfterSeconds ? err.retryAfterSeconds : 60;
  throttledUntil = Math.max(throttledUntil, Date.now() + seconds * 1000);
}

export function isThrottled(): boolean {
  return Date.now() < throttledUntil;
}

/**
 * Forget a scope's sync state and stop any pass still running for it: a chat
 * leaving this device must not have an old pass commit into it afterwards —
 * least of all into the same chat re-joined a moment later.
 */
function dropScopeState(scopeId: ScopeId): void {
  const st = scopeStates.get(scopeId);
  if (!st) return;
  clearTimeout(st.retryTimer);
  st.controller?.abort();
  scopeStates.delete(scopeId);
}

function stateFor(scopeId: ScopeId): ScopeSyncState {
  let st = scopeStates.get(scopeId);
  if (!st) {
    st = {
      syncing: false,
      syncPromise: null,
      syncAgain: false,
      lastSyncAt: 0,
      consecutiveGone: 0,
      lastMembersFetch: 0,
      lastDescriptorFetch: 0,
      completedOnce: false,
      controller: null,
      forceFull: false,
      lastPassFailed: false,
      retryCount: 0,
      retryTimer: undefined,
    };
    scopeStates.set(scopeId, st);
  }
  return st;
}

async function syncDeviceProfiles(): Promise<{ cTag?: string; count: number }> {
  const local = await ensureCurrentDeviceProfile();
  const pending = await db.getSetting<DeviceProfile>(PENDING_DEVICE_PROFILE_KEY);
  if (pending) {
    await graph.putDeviceProfile(pending);
    const latest = await db.getSetting<DeviceProfile>(PENDING_DEVICE_PROFILE_KEY);
    if (latest?.updatedAt === pending.updatedAt) {
      await db.deleteSetting(PENDING_DEVICE_PROFILE_KEY);
    }
  }

  const before = await db.getAllDeviceProfiles();
  // Unchanged since the last listing: one cTag GET, no downloads.
  const snapshot = await graph.listDeviceProfiles(await graph.getKnownDeviceRegistryCTag());
  if (!snapshot.profiles) return { cTag: snapshot.cTag, count: before.length };
  const remote = snapshot.profiles;
  const remoteLocal = remote.find(profile => profile.id === local.id);
  const current = remoteLocal && remoteLocal.updatedAt > local.updatedAt ? remoteLocal : local;
  const profiles = [...remote.filter(profile => profile.id !== current.id), current];
  await db.replaceAllDeviceProfiles(profiles);

  const beforeState = before
    .map(profile => `${profile.id}:${profile.name}:${profile.updatedAt}`)
    .sort()
    .join('|');
  const afterState = profiles
    .map(profile => `${profile.id}:${profile.name}:${profile.updatedAt}`)
    .sort()
    .join('|');
  if (beforeState !== afterState) {
    emit({ type: 'feed-updated', scopeId: PRIVATE_SCOPE_ID });
    postBroadcast({ type: 'sync-complete', scopeId: PRIVATE_SCOPE_ID });
  }
  return { cTag: snapshot.cTag, count: profiles.length };
}

/**
 * The private feed's device profiles, synced alongside its drops rather than
 * ahead of them: they only label drops, so neither the feed nor a send should
 * wait on them. Never rejects. The registry cTag was read before the listing,
 * so marking it clean here can't hide a change that landed meanwhile.
 */
async function runDevicesPhase(): Promise<{ ms: number; count?: number }> {
  const t0 = performance.now();
  try {
    const synced = await syncDeviceProfiles();
    if (synced.cTag) await graph.markDeviceRegistryClean(synced.cTag);
    return { ms: performance.now() - t0, count: synced.count };
  } catch (err) {
    console.warn('[Sync] Device profile sync failed; drops sync on:', err);
    return { ms: performance.now() - t0 };
  }
}

/**
 * Pick out the drops this install had never held, sent by someone else.
 *
 * Novelty is presence in IDB, not id order. ULIDs are minted when a drop is
 * composed but only published when the author's outbox drains — and in chats
 * other members' clocks can skew — so id order never decides novelty.
 *
 * `added` is what the commit itself found absent (db.commitDropChanges):
 * decided in the write transaction, so batches of one pass can't hide each
 * other's drops, and a second tab syncing the same scope can't count a drop
 * the first tab already wrote.
 */
function pickArrivals(
  scope: Scope,
  records: DropRecord[],
  added: ReadonlySet<string>,
  selfId: string | undefined,
): DropMeta[] {
  return records
    .filter(record => added.has(record.meta.id))
    .filter(record =>
      scope.kind === 'private' ? record.meta.device.id !== selfId : record.meta.author?.id !== selfId,
    )
    .map(record => record.meta)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Announce drops that arrived from someone else.
 *
 * The first completed pass for a scope only primes: a fresh sign-in (or a
 * fresh join) reads the entire existing history as new, and announcing it
 * would be a wall of notifications. Priming has to happen even when that
 * pass found nothing, or the first drop the scope ever receives would be
 * mistaken for backlog.
 *
 * A pass that failed after committing some batches passes `mayPrime: false`:
 * it announces into an already-primed scope, but never primes one — or an
 * interrupted first sync would announce the rest of the history as new.
 */
async function announceArrivals(scope: Scope, arrivals: DropMeta[], mayPrime: boolean): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const primed = await db.getSetting<boolean>(notifyPrimedKey(scopeId));
  if (!primed) {
    if (mayPrime) await db.putSetting(notifyPrimedKey(scopeId), true);
    return;
  }
  if (!arrivals.length || !notify.isNotifyEnabled()) return;

  if (scope.kind === 'private') {
    const profiles = await db.getAllDeviceProfiles();
    const names = new Map(profiles.map(profile => [profile.id, profile.name]));
    await notify.announceItems(arrivals.map(meta => ({
      id: meta.id,
      title: (meta.device.id && names.get(meta.device.id)) || meta.device.name,
      body: notify.describeDrop(meta),
      scopeId,
    })));
  } else {
    await notify.announceItems(arrivals.map(meta => ({
      id: meta.id,
      title: `${scope.name} · ${meta.author?.name ?? scope.host.name}`,
      body: notify.describeDrop(meta),
      scopeId,
    })));
  }
}

/** Bump a chat's unread count unless the user is looking at it right now. */
async function trackUnread(scope: Scope, arrivals: DropMeta[]): Promise<void> {
  if (scope.kind !== 'chat' || !arrivals.length) return;
  const scopeId = scopeIdOf(scope);
  const activeScopeId = await getActiveScopeId();
  if (scopeId === activeScopeId && document.visibilityState === 'visible') return;
  const record = await db.getChat(scope.chatId);
  if (!record) return;
  await db.patchChat(scope.chatId, { unreadCount: (record.unreadCount ?? 0) + arrivals.length });
  emit({ type: 'chats-changed' });
}

/** The scope's feed was rendered while visible — clear its badge. */
export async function markScopeRead(scopeId: ScopeId, lastDropId?: string): Promise<void> {
  if (!scopeId.startsWith('chat:')) return;
  const chatId = scopeId.slice(5);
  const record = await db.getChat(chatId);
  if (!record) return;
  if ((record.unreadCount ?? 0) === 0 && record.lastReadDropId === lastDropId) return;
  await db.patchChat(chatId, { unreadCount: 0, ...(lastDropId ? { lastReadDropId: lastDropId } : {}) });
  emit({ type: 'chats-changed' });
}

async function handleChatGone(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record || record.state === 'gone') return;
  await db.patchChat(chatId, { state: 'gone' });
  // Queued sends for a gone chat can never deliver — make them terminal.
  const outbox = await db.getOutbox();
  for (const r of outbox) {
    if (r.scopeId === `chat:${chatId}` && r.state !== 'failed') {
      await db.putOutboxRecord({ ...r, state: 'failed' });
    }
  }
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
}

async function handleChatConsentLost(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record || record.state === 'needs-consent') return;
  await db.patchChat(chatId, { state: 'needs-consent' });
  emit({ type: 'chats-changed' });
}

/**
 * Pick up a rename made on another device. A pass that moved no drops was
 * triggered by something else under the chat folder (the folder cTag
 * covers chat.json too), so that is when the descriptor is worth one GET;
 * otherwise it is re-read on the members cadence. A changed name patches
 * the record and tells the switcher, the feed header and the other tabs.
 */
async function refreshDescriptor(scope: ChatScope, st: ScopeSyncState, passChanged: boolean): Promise<void> {
  const stale = Date.now() - st.lastDescriptorFetch > MEMBERS_REFRESH_MS;
  if (passChanged && !stale) return;
  const record = await db.getChat(scope.chatId);
  if (!record) return;
  const descriptor = await chatsApi.fetchChatDescriptor(record);
  st.lastDescriptorFetch = Date.now();
  if (!descriptor || descriptor.name === record.name) return;
  await db.patchChat(scope.chatId, { name: descriptor.name });
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
}

/** Refresh the cached member roster when it's stale or the pass changed things. */
async function refreshMembers(scope: ChatScope, st: ScopeSyncState, passChanged: boolean): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const cached = await db.getSetting(membersKey(scopeId));
  const stale = Date.now() - st.lastMembersFetch > MEMBERS_REFRESH_MS;
  if (cached && !passChanged && !stale) return;
  const members = await chatsApi.listMembers(scope);
  st.lastMembersFetch = Date.now();
  if (members.length) await db.putSetting(membersKey(scopeId), members);
}

/**
 * Run a sync pass for a scope: drain its outbox, then delta (or listing
 * fallback) into IDB. Serialized and rate-floored per scope.
 *
 * `knownCTag` is a folder cTag the caller read just now (a poll tick's dirty
 * check), committed with the pass instead of asking for it again.
 */
export function requestSync(scope: Scope, opts: { force?: boolean; knownCTag?: string } = {}): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const st = stateFor(scopeId);
  if (st.syncPromise) {
    if (opts.force) st.syncAgain = true;
    return st.syncPromise;
  }
  if (shuttingDown || resettingScopes.has(scopeId)) return Promise.resolve();
  const now = Date.now();
  if (!opts.force && now - st.lastSyncAt < SYNC_FLOOR_MS) return Promise.resolve();
  if (now < throttledUntil) return Promise.resolve();
  st.syncPromise = runScopeSync(scope, st, opts.knownCTag);
  return st.syncPromise;
}

/**
 * A commit was refused because the chat left this device while its pass was
 * downloading (see db.commitDropChanges). Nothing was written, so nothing
 * may be counted, shown or announced: abort the pass, which ends it quietly.
 */
function stopForRemovedScope(controller: AbortController): never {
  const reason = new DOMException('The chat was removed during its sync pass.', 'AbortError');
  controller.abort(reason);
  throw reason;
}

/** Network trouble rather than a verdict — worth another pass soon. */
function isTransientSyncError(err: unknown): boolean {
  // An expired download link or a storage hiccup: a new pass mints fresh links.
  if (err instanceof graph.DownloadError) return true;
  if (err instanceof graph.GraphHttpError) return err.status >= 500 && !graph.isThrottleError(err);
  if (err instanceof DOMException) return err.name === 'TimeoutError';
  return err instanceof TypeError; // fetch's network failure
}

/**
 * A pass that failed on the network gets a few quick retries while the app
 * is on screen — a first sync interrupted by a flaky connection resumes in
 * seconds, not at the next 45 s poll. Each retry skips what already landed.
 */
function scheduleRetry(scope: Scope, st: ScopeSyncState, err: unknown): void {
  if (shuttingDown || !isTransientSyncError(err)) return;
  const delay = RETRY_DELAYS_MS[st.retryCount];
  if (delay === undefined) return; // the poll takes it from here
  st.retryCount++;
  clearTimeout(st.retryTimer);
  st.retryTimer = setTimeout(() => {
    st.retryTimer = undefined;
    if (document.visibilityState === 'visible') void requestSync(scope, { force: true });
  }, delay);
}

async function runScopeSync(scope: Scope, st: ScopeSyncState, knownCTag?: string): Promise<void> {
  const scopeId = scopeIdOf(scope);
  st.syncing = true;
  let aborted = false;
  try {
    do {
      st.syncAgain = false;
      st.lastSyncAt = Date.now();
      clearTimeout(st.retryTimer);
      st.retryTimer = undefined;
      const controller = new AbortController();
      st.controller = controller;
      emit({ type: 'sync-start', scopeId });

      // Diagnostics for this pass (Settings › Sync diagnostics).
      const counts = newPassCounts();
      const startedAt = Date.now();
      const t0 = performance.now();
      const requestsBefore = requestCount();
      let mode: PassStats['mode'] = 'incremental';
      let firstCommitMs: number | undefined;
      let removed = 0;
      let outcome: PassStats['outcome'] = 'ok';
      let error: string | undefined;

      const devicesTask = scope.kind === 'private' ? runDevicesPhase() : undefined;
      /** Drops that arrived in batches this pass committed — announced even if it fails later. */
      const arrivals: DropMeta[] = [];
      let received = 0;
      // Someone asked for a full enumeration (see discardOutboxRecord).
      // Taken before the snapshot below; handed back if this pass fails.
      const fromScratch = st.forceFull;
      st.forceFull = false;

      try {
        let chatRecord: ChatRecord | undefined;
        if (scope.kind === 'chat') {
          chatRecord = await db.getChat(scope.chatId);
          if (!chatRecord || chatRecord.state === 'gone') {
            emit({ type: 'sync-complete', scopeId });
            return;
          }
        }

        await drainOutbox(scopeId);

        // The cTag this pass will commit, read BEFORE the delta (see
        // graph.readFeedCTag). A poll tick's value is only good for the
        // first iteration; a repeat reads afresh.
        // Only a private feed with no drops folder yet (a new account) is
        // "no cTag". Anything else — a throttle above all, whose Retry-After
        // must stop this pass before it enumerates — fails the pass.
        const cTag =
          knownCTag ??
          (await graph.readFeedCTag(scope).catch(err => {
            if (scope.kind === 'private' && graph.isGoneError(err)) return undefined;
            throw err;
          }));
        knownCTag = undefined;

        // What this device holds as the pass starts: the eTags let it skip
        // bodies it already has, the ids are what a full pass may sweep.
        // Taken before any batch below is written.
        const known = await db.getScopeDropETags(scopeId);
        const heldBefore = new Set(known.keys());
        const selfId = scope.kind === 'private' ? device.getDeviceId() : (await ensureMe())?.id;
        // Decided up front, so a first sync that fails is still recorded as one.
        if (
          chatRecord?.syncStrategy !== 'listing' &&
          (fromScratch || !(await db.getSetting(graph.deltaTokenKey(scope))))
        ) {
          mode = 'full';
        }

        let total = 0;
        let lastBroadcast = 0;
        const deltaOpts: graph.DeltaOptions = {
          stats: counts,
          known,
          fromScratch,
          signal: controller.signal,
          onEnumerated: toDownload => {
            total = toDownload;
            if (total) emit({ type: 'sync-progress', scopeId, received, total });
          },
          // Each batch is committed and shown as it arrives, newest first.
          onBatch: async records => {
            const { written, added } = await db.commitDropChanges(scopeId, { puts: records });
            if (!written) stopForRemovedScope(controller);
            arrivals.push(...pickArrivals(scope, records, added, selfId));
            firstCommitMs ??= performance.now() - t0;
            received += records.length;
            emit({ type: 'sync-progress', scopeId, received, total });
            emit({ type: 'feed-updated', scopeId });
            if (Date.now() - lastBroadcast >= BROADCAST_EVERY_MS) {
              lastBroadcast = Date.now();
              postBroadcast({ type: 'sync-complete', scopeId });
            }
          },
        };

        let result: graph.DeltaResult;
        if (scope.kind === 'private') {
          result = await graph.runDelta(scope, deltaOpts);
        } else {
          const strategy = chatRecord?.syncStrategy;
          const synced = await chatsApi.runChatSync(scope, strategy, known, deltaOpts);
          result = synced.result;
          if (synced.strategy === 'listing') mode = 'listing';
          if (synced.strategy !== (strategy ?? 'delta')) {
            await db.patchChat(scope.chatId, { syncStrategy: synced.strategy });
          }
        }
        if (result.fullResync) mode = 'full';

        // A full pass is the complete server state: a drop this device held
        // before the pass that the pass never found is gone. Only ids held
        // BEFORE the pass are swept, so a drop a concurrent outbox drain
        // wrote meanwhile (a send, an edit) survives.
        const deletes = new Set(result.removals);
        if (result.fullResync) {
          for (const id of heldBefore) if (!result.seenIds.has(id)) deletes.add(id);
        }

        const tokenKey = graph.deltaTokenKey(scope);
        const settingsPut: Array<[string, unknown]> = [];
        const settingsDelete: string[] = [];
        if (result.deltaLink) settingsPut.push([tokenKey, result.deltaLink]);
        // A full pass that produced no token (no drops folder yet) retires
        // any stale one, so the next pass doesn't trip over it again.
        else if (result.fullResync) settingsDelete.push(tokenKey);
        if (cTag) settingsPut.push([graph.folderCtagKey(scope), cTag]);

        // The last drops, the removals, the token and the cTag land together.
        const { written, added } = await db.commitDropChanges(scopeId, {
          puts: result.upserts,
          deletes: [...deletes],
          settingsPut,
          settingsDelete,
        });
        if (!written) stopForRemovedScope(controller);
        arrivals.push(...pickArrivals(scope, result.upserts, added, selfId));
        // "First drops" only when this commit carried some: an empty account,
        // or a pass that skipped every body, shows no such moment.
        if (result.upserts.length) firstCommitMs ??= performance.now() - t0;
        received += result.upserts.length;
        // Only what this device actually held: the tombstone for a drop it
        // deleted itself (already gone locally) is not a removal.
        removed = [...deletes].filter(id => heldBefore.has(id)).length;
        st.completedOnce = true;
        st.retryCount = 0;
        st.lastPassFailed = false;

        const passChanged = received > 0 || deletes.size > 0 || result.fullResync;
        if (scope.kind === 'chat') {
          st.consecutiveGone = 0;
          const record = await db.getChat(scope.chatId);
          if (record?.state && record.state !== 'active') {
            await db.patchChat(scope.chatId, { state: 'active' });
            emit({ type: 'chats-changed' });
          }
          // The drops are in: show them before the roster and name refresh.
          if (passChanged) emit({ type: 'feed-updated', scopeId });
          try {
            await refreshMembers(scope, st, passChanged);
          } catch (err) {
            console.debug('[Sync] Member refresh failed; roster is stale:', err);
          }
          try {
            await refreshDescriptor(scope, st, passChanged);
          } catch (err) {
            console.debug('[Sync] Descriptor refresh failed; name may be stale:', err);
          }
          await trackUnread(scope, arrivals);
        }

        // Announcements name the sending device, so let its profile land first.
        await devicesTask;
        try {
          await announceArrivals(scope, arrivals, true);
        } catch (err) {
          console.warn('[Sync] Announcing arrivals failed; drops are synced:', err);
        }

        if (passChanged) {
          emit({ type: 'feed-updated', scopeId });
          postBroadcast({ type: 'sync-complete', scopeId });
        }
        emit({ type: 'sync-complete', scopeId });
      } catch (err) {
        outcome = 'error';
        error = errorLabel(err);
        aborted = controller.signal.aborted;
        if (fromScratch) st.forceFull = true;
        if (aborted) {
          // A reset or sign-out stopped this pass on purpose — not a failure
          // to report; whoever aborted it takes it from here.
          console.debug('[Sync] Pass for %s aborted', scopeId);
        } else {
          st.lastPassFailed = true;
          noteThrottle(err);
          if (scope.kind === 'chat' && graph.isAccessLostError(err)) {
            st.consecutiveGone++;
            if (st.consecutiveGone >= GONE_THRESHOLD) await handleChatGone(scope.chatId);
          } else if (scope.kind === 'chat' && err instanceof ConsentRequiredError) {
            await handleChatConsentLost(scope.chatId);
          }
          // Batches that did commit are real arrivals.
          if (arrivals.length) {
            try {
              await trackUnread(scope, arrivals);
              await devicesTask;
              await announceArrivals(scope, arrivals, false);
            } catch (announceErr) {
              console.debug('[Sync] Announcing partial arrivals failed:', announceErr);
            }
          }
          if (received > 0) postBroadcast({ type: 'sync-complete', scopeId });
          console.warn('[Sync] Sync pass failed (%s):', scopeId, err);
          emit({ type: 'sync-error', scopeId, error: err });
          scheduleRetry(scope, st, err);
        }
      }

      // An abort that landed after the pass's last abortable step (its final
      // commit, the roster refresh) still ends the loop: whoever aborted is
      // waiting for this pass to get out of the way, not for another one.
      aborted ||= controller.signal.aborted;
      st.controller = null;
      const devicesPhase = await devicesTask;
      void recordPass({
        ...counts,
        scope: scope.kind,
        mode,
        outcome,
        error,
        startedAt,
        totalMs: performance.now() - t0,
        firstCommitMs,
        devicesMs: devicesPhase?.ms,
        devices: devicesPhase?.count,
        removed,
        requests: requestCount() - requestsBefore,
      }).catch(err => console.debug('[Sync] Could not record pass stats:', err));
    } while (st.syncAgain && !aborted && !shuttingDown);
  } finally {
    st.syncing = false;
    st.syncPromise = null;
    st.controller = null;
  }
}

/**
 * Sign-out: stop every pass and close local storage to writes before the
 * wipe, so nothing downloaded afterwards can land under the next account.
 */
export function shutdown(): void {
  shuttingDown = true;
  db.closeWrites();
  for (const st of scopeStates.values()) {
    clearTimeout(st.retryTimer);
    st.controller?.abort();
  }
}

/** Re-read a scope's feed from IDB after another tab synced (no network). */
export function refreshFromCache(scopeId: ScopeId): void {
  emit({ type: 'feed-updated', scopeId });
}

/**
 * Coming back to the app: sync only what moved. Queued sends (or a pending
 * profile write) force a pass, as on a poll tick; otherwise the cTag probe
 * decides, so returning to an idle app costs a GET or two, not a full pass.
 */
export async function syncIfDirty(scope: Scope): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const outbox = await db.getOutbox();
  const hasWork =
    outbox.some(r => r.state !== 'failed' && (r.scopeId ?? PRIVATE_SCOPE_ID) === scopeId) ||
    (scope.kind === 'private' && Boolean(await db.getSetting(PENDING_DEVICE_PROFILE_KEY)));
  // A pass that failed (the app was opened offline, say) is tried again even
  // if nothing changed remotely — otherwise "Sync failed" would sit there
  // until the next remote change or a manual refresh.
  if (hasWork || stateFor(scopeId).lastPassFailed) return requestSync(scope, { force: true });
  if (Date.now() < throttledUntil) return;
  await pollScope(scopeId);
}

/**
 * True until a scope finishes its first pass on this device: no delta token
 * stored and no pass completed this session. The feed says "fetching" rather
 * than "empty" meanwhile. A brand-new account (no drops folder) never gets a
 * token, so its first completed pass is what ends this.
 */
export async function isFirstSyncPending(scopeId: ScopeId): Promise<boolean> {
  if (stateFor(scopeId).completedOnce) return false;
  const scope = await resolveScope(scopeId);
  if (!scope) return false;
  return !(await db.getSetting<string>(graph.deltaTokenKey(scope)));
}

const resettingScopes = new Set<ScopeId>();

/**
 * Forget what this device holds for a scope and sync it again from nothing:
 * Settings' "Re-sync from scratch", which reproduces a fresh install's first
 * sync without signing out. Queued sends stay queued.
 *
 * The notification primer is cleared too, so the re-sync primes quietly
 * instead of announcing the whole feed as new.
 */
export async function resetScope(scope: Scope): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const st = stateFor(scopeId);
  resettingScopes.add(scopeId);
  try {
    // Stop a running pass and let it wind down, or it would write back over
    // the reset.
    clearTimeout(st.retryTimer);
    st.controller?.abort();
    while (st.syncPromise) await st.syncPromise.catch(() => {});
    st.completedOnce = false;
    st.retryCount = 0;
    await graph.forgetSyncState(scope);
    await db.deleteSetting(notifyPrimedKey(scopeId));
    await db.clearScopeDrops(scopeId);
  } finally {
    resettingScopes.delete(scopeId);
  }
  emit({ type: 'feed-updated', scopeId });
  await requestSync(scope, { force: true });
}

// ─── polling ───

let rotationIndex = 0;

async function pollScope(scopeId: ScopeId): Promise<void> {
  const st = scopeStates.get(scopeId);
  if (st?.syncing) return;
  const scope = await resolveScope(scopeId);
  if (!scope) return;
  if (scope.kind === 'chat') {
    const record = await db.getChat(scope.chatId);
    if (!record || (record.state ?? 'active') !== 'active') return;
  }
  try {
    const [feed, devicesDirty] = await Promise.all([
      graph.isFeedDirty(scope),
      scope.kind === 'private' ? graph.isDeviceRegistryDirty() : Promise.resolve(false),
    ]);
    if (feed.dirty || devicesDirty) await requestSync(scope, { force: true, knownCTag: feed.cTag });
  } catch (err) {
    noteThrottle(err);
    if (scope.kind === 'chat' && graph.isAccessLostError(err)) {
      const chatState = stateFor(scopeId);
      chatState.consecutiveGone++;
      if (chatState.consecutiveGone >= GONE_THRESHOLD) await handleChatGone(scope.chatId);
    } else if (scope.kind === 'chat' && err instanceof ConsentRequiredError) {
      await handleChatConsentLost(scope.chatId);
    } else {
      console.debug('[Sync] Poll of %s failed:', scopeId, err);
    }
  }
}

/**
 * Cheap poll tick. The active scope is dirty-checked every tick; background
 * scopes take turns, one per tick — so the ceiling is 5 cTag GETs per tick
 * (two registry folders, active + devices, one background) no matter how
 * many chats exist. Queued outbox work always forces a sync for its scope.
 */
export async function pollAll(activeScopeId: ScopeId): Promise<void> {
  if (shuttingDown || Date.now() < throttledUntil) return;
  // Land any join/leave the account made here that OneDrive has not yet
  // heard about, then pick up chats created/joined/left on other devices.
  // Both self-gate: the drain is a no-op with an empty queue, the registry
  // pass costs two cTag GETs unless something actually changed.
  void catchUpRegistry();
  try {
    const outbox = await db.getOutbox();
    const pendingProfile = await db.getSetting<DeviceProfile>(PENDING_DEVICE_PROFILE_KEY);
    const scopesWithWork = new Set<ScopeId>(
      outbox.filter(r => r.state !== 'failed').map(r => r.scopeId ?? PRIVATE_SCOPE_ID),
    );
    if (pendingProfile) scopesWithWork.add(PRIVATE_SCOPE_ID);
    for (const scopeId of scopesWithWork) {
      const scope = await resolveScope(scopeId);
      if (scope) void requestSync(scope, { force: true });
    }

    await pollScope(activeScopeId);

    const chats = await db.getAllChats();
    const candidates: ScopeId[] = [
      PRIVATE_SCOPE_ID,
      ...chats.filter(c => (c.state ?? 'active') === 'active').map(c => `chat:${c.id}`),
    ].filter(scopeId => scopeId !== activeScopeId && !scopesWithWork.has(scopeId));
    if (candidates.length) {
      rotationIndex = (rotationIndex + 1) % candidates.length;
      await pollScope(candidates[rotationIndex]);
    }
  } catch (err) {
    console.debug('[Sync] Poll tick failed:', err);
  }
}

// ─── chat lifecycle ───

export function loadChats(): Promise<ChatRecord[]> {
  return db.getAllChats();
}

/** Create a chat (host). Requires share consent — throws ConsentRequiredError otherwise. */
export async function createChat(name: string): Promise<ChatRecord> {
  const me = await ensureMe();
  if (!me) throw new Error('Your Microsoft profile has not loaded yet — check your connection.');
  const record: ChatRecord = {
    ...(await chatsApi.createChatFolder(name.trim() || 'Untitled chat', me)),
    registeredAt: Date.now(),
  };
  await db.putChat(record);
  // The creator has read everything there is (nothing); prime notifications.
  await db.putSetting(notifyPrimedKey(`chat:${record.id}`), true);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
  return record;
}

export const MAX_CHAT_NAME = 64;

/**
 * Host: rename a chat for everyone. The name lives in chat.json in the
 * host's approot (base tier — no share consent involved); the host's other
 * devices and every guest read it back on their next sync pass, which the
 * folder-cTag change this write causes will trigger.
 */
export async function renameChat(chatId: string, name: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record || record.role !== 'host') throw new Error('Only the host can rename a chat');
  const trimmed = name.trim().slice(0, MAX_CHAT_NAME);
  if (!trimmed) throw new Error('A chat needs a name');
  if (trimmed === record.name) return;
  // Re-read rather than rebuild: createdAt/host must round-trip untouched.
  const current = await chatsApi.fetchChatDescriptor(record);
  if (!current) throw new Error('The chat descriptor is missing');
  await chatsApi.putChatDescriptor({ ...current, name: trimmed });
  await db.patchChat(chatId, { name: trimmed });
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
}

/** Host: get (or mint) the invite link for a chat. Share tier. */
export async function ensureInviteLink(chatId: string): Promise<string> {
  const record = await db.getChat(chatId);
  if (!record) throw new Error('Unknown chat');
  if (record.shareUrl) return record.shareUrl;
  const link = await chatsApi.createInviteLink(record);
  await db.patchChat(chatId, { shareUrl: link.webUrl });
  return link.webUrl;
}

/** Host: rotate the invite link — revokes the old link's grants. */
export async function rotateInviteLink(chatId: string): Promise<string> {
  const record = await db.getChat(chatId);
  if (!record) throw new Error('Unknown chat');
  const permissions = await chatsApi.listChatPermissions(record);
  for (const permission of permissions.filter(p => p.isLink)) {
    await chatsApi.deleteChatPermission(record, permission.id);
  }
  const link = await chatsApi.createInviteLink(record);
  await db.patchChat(chatId, { shareUrl: link.webUrl });
  return link.webUrl;
}

export function getCachedMembers(scopeId: ScopeId): Promise<import('../types').ChatMember[] | undefined> {
  return db.getSetting(membersKey(scopeId));
}

/**
 * Host: revoke one member's direct permission grant. Consumer OneDrive may
 * only expose link-level grants (everyone who redeemed the link shares one
 * permission) — then there is nothing individual to delete and this throws
 * 'unsupported'; the UI offers "Reset invite link" instead.
 */
export async function removeMember(chatId: string, memberId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record || record.role !== 'host') throw new Error('Only the host can remove members');
  const permissions = await chatsApi.listChatPermissions(record);
  const direct = permissions.find(p => !p.isLink && p.granteeIds.includes(memberId));
  if (!direct) throw new Error('unsupported');
  await chatsApi.deleteChatPermission(record, direct.id);
  await chatsApi.deleteMemberFile(record, memberId).catch(() => {});
  const members = await chatsApi.listMembers(record);
  await db.putSetting(membersKey(`chat:${chatId}`), members);
  emit({ type: 'chats-changed' });
}

/** A needs-consent chat regained its grant — try it again right away. */
export async function reactivateChat(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record) return;
  await db.patchChat(chatId, { state: 'active' });
  const st = stateFor(`chat:${chatId}`);
  st.consecutiveGone = 0;
  emit({ type: 'chats-changed' });
  void requestSync(chatScopeOf({ ...record, state: 'active' }), { force: true });
}

export class JoinError extends Error {
  constructor(public reason: 'invalid-link' | 'not-a-chat') {
    super(reason);
  }
}

/**
 * Join a chat from a sharing token (guest), or re-register one of our own
 * chats opened from its own invite link (host on a new device). Idempotent:
 * an already-registered chat is returned as-is.
 */
export async function joinChat(shareToken: string): Promise<ChatRecord> {
  const me = await ensureMe();
  if (!me) throw new Error('Your Microsoft profile has not loaded yet — check your connection.');

  let resolution: chatsApi.SharedChatResolution | null;
  try {
    resolution = await chatsApi.resolveSharedChat(shareToken);
  } catch (err) {
    if (
      err instanceof graph.GraphHttpError &&
      (err.status === 400 || err.status === 403 || err.status === 404 || err.status === 410)
    ) {
      throw new JoinError('invalid-link');
    }
    throw err;
  }
  if (!resolution) throw new JoinError('not-a-chat');
  const { descriptor } = resolution;

  const existing = await db.getChat(descriptor.id);
  if (existing) return existing;

  const isOwnChat = descriptor.host.id === me.id;
  const joinedAt = Date.now();
  const record: ChatRecord = {
    id: descriptor.id,
    name: descriptor.name,
    role: isOwnChat ? 'host' : 'guest',
    driveId: resolution.driveId,
    itemId: resolution.itemId,
    dropsItemId: resolution.dropsItemId,
    host: descriptor.host,
    joinedAt,
    state: 'active',
    registeredAt: joinedAt,
  };

  if (!isOwnChat) {
    await chatsApi.putMemberSelf(record, { v: 1, id: me.id, name: me.name, joinedAt, updatedAt: joinedAt });
    // Roaming pointer in our own approot, so the chat follows the account
    // to its other devices. Queued before the local record exists: the
    // registry reconcile never removes a chat whose pointer is still on its
    // way, and the drain below retries until OneDrive has it.
    await enqueueRegistryOp({
      op: 'put-pointer',
      chatId: record.id,
      pointer: {
        v: 1,
        chatId: record.id,
        name: record.name,
        driveId: record.driveId,
        itemId: record.itemId,
        dropsItemId: record.dropsItemId,
        host: record.host,
        joinedAt,
      },
    });
  }

  await db.putChat(record);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
  void drainRegistryOutbox();
  // The first sync primes notifications (per-scope primed key) so a joined
  // chat's backlog never lands as a notification wall.
  void requestSync(chatScopeOf(record), { force: true });
  return record;
}

/**
 * Guest: leave a chat. Local cleanup is immediate; the remote cleanup
 * (member file, roaming pointer) is queued durably so the leave reaches
 * the account's other devices even if this attempt is throttled or offline.
 */
export async function leaveChat(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record) return;
  if (record.role === 'guest') {
    if (record.state !== 'gone') {
      const me = await ensureMe();
      if (me) {
        await enqueueRegistryOp({
          op: 'delete-member',
          chatId,
          driveId: record.driveId,
          itemId: record.itemId,
          memberId: me.id,
        });
      }
    }
    await enqueueRegistryOp({ op: 'delete-pointer', chatId });
  }
  await forgetChat(record);
  void drainRegistryOutbox();
}

/** Drop a chat from this install and tell every listener, this tab's and the others'. */
async function forgetChat(record: ChatRecord): Promise<void> {
  dropScopeState(`chat:${record.id}`);
  await db.clearScopeData(`chat:${record.id}`);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed', removedChatId: record.id });
}

/** Host: delete the chat for everyone (removes the folder from OneDrive). */
export async function deleteChatHosted(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record || record.role !== 'host') return;
  await chatsApi.deleteChatFolder(chatId);
  dropScopeState(`chat:${chatId}`);
  await db.clearScopeData(`chat:${chatId}`);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
}

/**
 * Remove a gone chat from the list. Access already ended, so there is no
 * member file to clean up — but a guest's roaming pointer must still go,
 * or the next registry pass would bring the dead chat back here and keep
 * it on every other device.
 */
export async function removeChatLocally(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record) return;
  if (record.role === 'guest') await enqueueRegistryOp({ op: 'delete-pointer', chatId });
  await forgetChat(record);
  void drainRegistryOutbox();
}

// ─── registry outbox drain ───

let drainingRegistry = false;
let drainRegistryAgain = false;
const REGISTRY_BACKOFF_BASE_MS = 5_000;
const REGISTRY_BACKOFF_CAP_MS = 30 * 60_000;

/**
 * Drain the registry outbox, then reconcile the registry — the pair every
 * boot, poll tick, resume and reconnect runs. Neither half rejects, and a
 * failed drain never skips the reconcile.
 */
export async function catchUpRegistry(eager = false): Promise<void> {
  await drainRegistryOutbox();
  await hydrateChatRegistry(eager);
}

async function performRegistryOp(entry: RegistryOp): Promise<void> {
  switch (entry.op) {
    case 'put-pointer':
      await chatsApi.putJoinedPointer(entry.pointer);
      return;
    case 'delete-pointer':
      await chatsApi.deleteJoinedPointer(entry.chatId);
      return;
    case 'delete-member':
      try {
        await chatsApi.deleteMemberFile(entry, entry.memberId);
      } catch (err) {
        // Access already revoked (or the chat deleted) — nothing left to
        // remove, and no consent will ever make this write possible.
        if (!graph.isAccessLostError(err)) throw err;
      }
      return;
  }
}

/**
 * Land queued registry writes, oldest first. Never gives up on an entry:
 * these are the writes that keep the account's devices agreeing about
 * which chats it is in, so they back off (capped, Retry-After honoured)
 * rather than fail. A share-tier consent gap parks the entry untouched.
 *
 * Serialized: a call that arrives mid-drain (a join or leave enqueued while
 * an earlier drain is still writing) asks for one more pass instead of
 * being dropped, so a fresh intent never waits for the next poll tick.
 * Never rejects — a storage failure is logged and the caller carries on.
 */
export async function drainRegistryOutbox(): Promise<void> {
  if (drainingRegistry) {
    drainRegistryAgain = true;
    return;
  }
  drainingRegistry = true;
  try {
    do {
      drainRegistryAgain = false;
      await drainRegistryOnce();
    } while (drainRegistryAgain);
  } catch (err) {
    console.warn('[Chats] Registry outbox drain failed:', err);
  } finally {
    drainingRegistry = false;
  }
}

async function drainRegistryOnce(): Promise<void> {
  const now = Date.now();
  if (now < throttledUntil) return;
  for (const entry of await getRegistryOutbox()) {
    if (entry.nextAt > now) continue;
    try {
      await performRegistryOp(entry);
      await removeRegistryOp(entry.op, entry.chatId);
    } catch (err) {
      if (err instanceof ConsentRequiredError) continue; // wait for the reconnect flow
      noteThrottle(err);
      const attempts = entry.attempts + 1;
      const retryAfter =
        err instanceof graph.GraphHttpError && graph.isThrottleError(err) && err.retryAfterSeconds
          ? err.retryAfterSeconds * 1000
          : Math.min(REGISTRY_BACKOFF_BASE_MS * 2 ** (attempts - 1), REGISTRY_BACKOFF_CAP_MS);
      await deferRegistryOp(entry.op, entry.chatId, attempts, Date.now() + retryAfter);
      console.warn('[Chats] Registry %s for %s failed (attempt %d):', entry.op, entry.chatId, attempts, err);
      if (graph.isThrottleError(err)) return;
    }
  }
}

let hydrating = false;
let lastCheckedAt = 0;
let lastReconciledAt = 0;
/** Floor for the cTag probe on eager calls (resume, reconnect) — absorbs flapping. */
const REGISTRY_CHECK_FLOOR_MS = 5_000;
/** A full listing pass at least this often, whatever the cTags say. */
const REGISTRY_FULL_INTERVAL_MS = 30 * 60_000;
/** A record younger than this is never removed by a reconcile — its
 *  OneDrive write (chat folder, roaming pointer) may still be in flight. */
const REGISTRY_GRACE_MS = 60_000;
const REGISTRY_CTAG_KEY = 'milkbox:registry-ctags';

/**
 * Reconcile the local chat registry with OneDrive — chats this account
 * hosts (approot:/chats) and chats it joined (approot:/chats-joined roaming
 * pointers). Both live in our own approot, so discovery needs no share
 * consent; syncing a discovered guest chat surfaces needs-consent on its
 * own if the grant is missing.
 *
 * This is how a chat created, joined, left or deleted on ANOTHER device
 * shows up (or goes away) here, so it recurs for the life of the process:
 * pollAll calls it every tick and the resume/online handlers call it
 * eagerly. Each call is cheap — two cTag GETs — and the listings only run
 * when a cTag moved (or on the slow full-pass fallback).
 *
 * The listings are the truth: a local record absent from them is removed,
 * unless it is younger than the grace window or has a registry write still
 * queued. A listing that fails aborts the pass without touching anything.
 */
export async function hydrateChatRegistry(eager = false): Promise<void> {
  if (hydrating || Date.now() < throttledUntil) return;
  const now = Date.now();
  if (eager && now - lastCheckedAt < REGISTRY_CHECK_FLOOR_MS) return;
  hydrating = true;
  try {
    const me = await ensureMe();
    if (!me) return;

    const ctags = await chatsApi.getRegistryCTags();
    lastCheckedAt = Date.now();
    const known = await db.getSetting<chatsApi.RegistryCTags>(REGISTRY_CTAG_KEY);
    const dirty = !known || known.hosted !== ctags.hosted || known.joined !== ctags.joined;
    const overdue = now - lastReconciledAt >= REGISTRY_FULL_INTERVAL_MS;
    if (!dirty && !overdue) return;

    await reconcileChatRegistry(me);
    lastReconciledAt = Date.now();
    // Stored from before the listings: anything that changed while they ran
    // moves the cTag past this value and the next tick lists again.
    await db.putSetting(REGISTRY_CTAG_KEY, ctags);
  } catch (err) {
    // Nothing recorded — the next call retries; a 429 raises the global
    // gate above so the retry honors Retry-After.
    noteThrottle(err);
    console.debug('[Chats] Registry pass failed:', err);
  } finally {
    hydrating = false;
  }
}

async function reconcileChatRegistry(me: AuthorAttribution): Promise<void> {
  const local = await db.getAllChats();
  const localIds = new Set(local.map(c => c.id));
  const queue = await getRegistryOutbox();

  const hosted = await chatsApi.listHostChats(me, localIds);
  const joined = await chatsApi.listJoinedPointers(localIds);

  const now = Date.now();
  let changed = false;
  const discovered: ChatRecord[] = [];

  for (const record of hosted.records) {
    if (localIds.has(record.id)) continue;
    discovered.push({ ...record, registeredAt: now });
  }
  for (const pointer of joined.pointers) {
    if (localIds.has(pointer.chatId)) continue;
    // A pointer we are in the middle of deleting is not a chat to re-add.
    if (hasPendingRegistryOp(queue, 'delete-pointer', pointer.chatId)) continue;
    discovered.push({
      id: pointer.chatId,
      name: pointer.name,
      role: 'guest',
      driveId: pointer.driveId,
      itemId: pointer.itemId,
      dropsItemId: pointer.dropsItemId,
      host: pointer.host,
      joinedAt: pointer.joinedAt,
      state: 'active',
      registeredAt: now,
    });
  }
  for (const record of discovered) {
    // Re-check: a join/create on this device may have raced the listings.
    if (await db.getChat(record.id)) continue;
    await db.putChat(record);
    changed = true;
  }

  const removed: ChatRecord[] = [];
  for (const record of local) {
    if (record.registeredAt !== undefined && now - record.registeredAt < REGISTRY_GRACE_MS) continue;
    const present = record.role === 'host' ? hosted.ids.has(record.id) : joined.ids.has(record.id);
    if (present) continue;
    if (record.role === 'guest' && hasPendingRegistryOp(queue, 'put-pointer', record.id)) continue;
    // A pass mid-flight would write drops back under a cleared scope — let
    // it finish; the next reconcile removes the chat.
    if (scopeStates.get(`chat:${record.id}`)?.syncing) continue;
    // Gone on every other device too: the host deleted it, or we left it.
    const current = await db.getChat(record.id);
    if (!current) continue; // already left/removed while we listed
    dropScopeState(`chat:${record.id}`);
    await db.clearScopeData(`chat:${record.id}`);
    removed.push(current);
    changed = true;
  }

  if (!changed) return;
  emit({ type: 'chats-changed' });
  for (const record of removed) {
    emit({ type: 'chat-removed', chatId: record.id, name: record.name });
    postBroadcast({ type: 'chats-changed', removedChatId: record.id });
  }
  if (removed.length === 0) postBroadcast({ type: 'chats-changed' });
  // A discovered chat syncs now rather than waiting its turn in the
  // background rotation: the first pass primes notifications (no backlog
  // wall) and gives the switcher a chat with drops and a roster behind it.
  for (const record of discovered) {
    if (await db.getChat(record.id)) void requestSync(chatScopeOf(record), { force: true });
  }
}
