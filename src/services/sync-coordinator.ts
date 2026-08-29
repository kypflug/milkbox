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

export type CoordinatorEvent =
  | { type: 'sync-start'; scopeId: ScopeId }
  | { type: 'sync-complete'; scopeId: ScopeId }
  | { type: 'sync-error'; scopeId: ScopeId; error: unknown }
  | { type: 'feed-updated'; scopeId: ScopeId }
  | { type: 'drop-progress'; scopeId: ScopeId; dropId: string; fraction: number }
  /** A queued chat edit lost its conditional write — the drop changed or was removed remotely. */
  | { type: 'drop-conflict'; scopeId: ScopeId; dropId: string }
  | { type: 'chats-changed' };

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
  void requestSync(scope, { force: true });
}

/** Queue an edit to an existing text drop. */
export async function enqueueEdit(scope: Scope, meta: DropMeta): Promise<void> {
  const scopeId = scopeIdOf(scope);
  await db.putOutboxRecord({ id: meta.id, meta, op: 'edit', attempts: 0, state: 'queued', scopeId });
  // Optimistically update the local record so the edit shows immediately
  const existing = await db.getDrop(scopeId, meta.id);
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
  emit({ type: 'feed-updated', scopeId: record?.scopeId ?? PRIVATE_SCOPE_ID });
}

const drainingScopes = new Set<ScopeId>();

/**
 * Drain one scope's outbox serially. Each record gets MAX_ATTEMPTS tries with
 * exponential backoff; throttle responses (429/503) pause the whole drain
 * for the server-requested interval.
 */
export async function drainOutbox(scopeId: ScopeId): Promise<void> {
  if (drainingScopes.has(scopeId)) return;
  drainingScopes.add(scopeId);
  try {
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
  } finally {
    drainingScopes.delete(scopeId);
  }
}

async function processOutboxRecord(scope: Scope, record: OutboxRecord): Promise<void> {
  const scopeId = scopeIdOf(scope);
  let attempts = record.attempts;
  while (attempts < MAX_ATTEMPTS) {
    try {
      await db.putOutboxRecord({ ...record, attempts, state: 'sending' });
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
        await db.putOutboxRecord({ ...record, attempts, state: 'failed' });
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
        // Persist so a reloaded tab resumes instead of restarting
        void db.putOutboxRecord({ ...record, uploadUrl });
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
}

const scopeStates = new Map<ScopeId, ScopeSyncState>();
const SYNC_FLOOR_MS = 5_000;
const MEMBERS_REFRESH_MS = 5 * 60_000;
const GONE_THRESHOLD = 3;

/** Global throttle gate — Graph throttles per app+user across all drives,
 *  so one 429 pauses every scope's polling and syncing. */
let throttledUntil = 0;

function noteThrottle(err: unknown): void {
  if (!graph.isThrottleError(err)) return;
  const seconds = err instanceof graph.GraphHttpError && err.retryAfterSeconds ? err.retryAfterSeconds : 60;
  throttledUntil = Math.max(throttledUntil, Date.now() + seconds * 1000);
}

function stateFor(scopeId: ScopeId): ScopeSyncState {
  let st = scopeStates.get(scopeId);
  if (!st) {
    st = { syncing: false, syncPromise: null, syncAgain: false, lastSyncAt: 0, consecutiveGone: 0, lastMembersFetch: 0 };
    scopeStates.set(scopeId, st);
  }
  return st;
}

async function syncDeviceProfiles(): Promise<string | undefined> {
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
  const snapshot = await graph.listDeviceProfiles();
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
  return snapshot.cTag;
}

/**
 * Pick out the upserts this install has never held before.
 *
 * Novelty is presence in IDB, not id order. ULIDs are minted when a drop is
 * composed but only published when the author's outbox drains — and in chats
 * other members' clocks can skew — so id order never decides novelty.
 *
 * Must be called before the pass writes upserts to IDB.
 */
async function collectArrivals(scope: Scope, upserts: DropRecord[]): Promise<DropMeta[]> {
  if (!upserts.length) return [];

  let candidates: DropRecord[];
  if (scope.kind === 'private') {
    const deviceId = device.getDeviceId();
    candidates = upserts.filter(record => record.meta.device.id !== deviceId);
  } else {
    const me = await ensureMe();
    candidates = upserts.filter(record => record.meta.author?.id !== me?.id);
  }
  if (!candidates.length) return [];

  const known = new Set(await db.getScopeDropIds(scopeIdOf(scope)));
  return candidates
    .filter(record => !known.has(record.meta.id))
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
 */
async function announceArrivals(scope: Scope, arrivals: DropMeta[]): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const primed = await db.getSetting<boolean>(notifyPrimedKey(scopeId));
  if (!primed) {
    await db.putSetting(notifyPrimedKey(scopeId), true);
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
 */
export function requestSync(scope: Scope, opts: { force?: boolean } = {}): Promise<void> {
  const scopeId = scopeIdOf(scope);
  const st = stateFor(scopeId);
  if (st.syncPromise) {
    if (opts.force) st.syncAgain = true;
    return st.syncPromise;
  }
  const now = Date.now();
  if (!opts.force && now - st.lastSyncAt < SYNC_FLOOR_MS) return Promise.resolve();
  if (now < throttledUntil) return Promise.resolve();
  st.syncPromise = runScopeSync(scope, st);
  return st.syncPromise;
}

async function runScopeSync(scope: Scope, st: ScopeSyncState): Promise<void> {
  const scopeId = scopeIdOf(scope);
  st.syncing = true;
  try {
    do {
      st.syncAgain = false;
      st.lastSyncAt = Date.now();
      emit({ type: 'sync-start', scopeId });

      try {
        let deviceCTag: string | undefined;
        if (scope.kind === 'private') {
          try {
            deviceCTag = await syncDeviceProfiles();
          } catch (err) {
            console.warn('[Sync] Device profile sync failed; continuing with drops:', err);
          }
        }
        await drainOutbox(scopeId);

        let result: graph.DeltaResult;
        if (scope.kind === 'private') {
          result = await graph.runDelta(scope);
        } else {
          const record = await db.getChat(scope.chatId);
          if (!record || record.state === 'gone') return;
          const known = await db.getScopeDropETags(scopeId);
          const synced = await chatsApi.runChatSync(scope, record.syncStrategy, known);
          result = synced.result;
          if (synced.strategy !== (record.syncStrategy ?? 'delta')) {
            await db.patchChat(scope.chatId, { syncStrategy: synced.strategy });
          }
        }

        // Snapshot novelty before the writes below land — afterwards every
        // upsert is present in IDB and indistinguishable from one we held.
        const arrivals = await collectArrivals(scope, result.upserts);

        if (result.fullResync) {
          // Reconcile: the pass IS the complete server state for this scope.
          await db.replaceScopeDrops(scopeId, result.upserts);
        } else {
          for (const record of result.upserts) await db.putDrop(scopeId, record);
          for (const id of result.removals) {
            await db.deleteDrop(scopeId, id);
            await db.deleteThumb(scopeId, id).catch(() => {});
            await db.deleteCachedBlob(scopeId, id).catch(() => {});
          }
        }

        await graph.markFeedClean(scope);
        if (scope.kind === 'private' && deviceCTag) await graph.markDeviceRegistryClean(deviceCTag);

        const passChanged = result.upserts.length > 0 || result.removals.length > 0 || result.fullResync;
        if (scope.kind === 'chat') {
          st.consecutiveGone = 0;
          const record = await db.getChat(scope.chatId);
          if (record?.state && record.state !== 'active') {
            await db.patchChat(scope.chatId, { state: 'active' });
            emit({ type: 'chats-changed' });
          }
          try {
            await refreshMembers(scope, st, passChanged);
          } catch (err) {
            console.debug('[Sync] Member refresh failed; roster is stale:', err);
          }
          await trackUnread(scope, arrivals);
        }

        try {
          await announceArrivals(scope, arrivals);
        } catch (err) {
          console.warn('[Sync] Announcing arrivals failed; drops are synced:', err);
        }

        if (passChanged) {
          emit({ type: 'feed-updated', scopeId });
          postBroadcast({ type: 'sync-complete', scopeId });
        }
        emit({ type: 'sync-complete', scopeId });
      } catch (err) {
        noteThrottle(err);
        if (scope.kind === 'chat' && graph.isGoneError(err)) {
          st.consecutiveGone++;
          if (st.consecutiveGone >= GONE_THRESHOLD) await handleChatGone(scope.chatId);
        } else if (scope.kind === 'chat' && err instanceof ConsentRequiredError) {
          await handleChatConsentLost(scope.chatId);
        }
        console.warn('[Sync] Sync pass failed (%s):', scopeId, err);
        emit({ type: 'sync-error', scopeId, error: err });
      }
    } while (st.syncAgain);
  } finally {
    st.syncing = false;
    st.syncPromise = null;
  }
}

/** Re-read a scope's feed from IDB after another tab synced (no network). */
export function refreshFromCache(scopeId: ScopeId): void {
  emit({ type: 'feed-updated', scopeId });
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
    const dirty = await graph.isFeedDirty(scope);
    const devicesDirty = scope.kind === 'private' ? await graph.isDeviceRegistryDirty() : false;
    if (dirty || devicesDirty) await requestSync(scope, { force: true });
  } catch (err) {
    noteThrottle(err);
    if (scope.kind === 'chat' && graph.isGoneError(err)) {
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
 * scopes take turns, one per tick — so the ceiling is 3 cTag GETs per tick
 * (active + devices + one background) no matter how many chats exist.
 * Queued outbox work always forces a sync for its scope.
 */
export async function pollAll(activeScopeId: ScopeId): Promise<void> {
  if (Date.now() < throttledUntil) return;
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

export async function getUnreadCounts(): Promise<Map<ScopeId, number>> {
  const chats = await db.getAllChats();
  return new Map(chats.map(c => [`chat:${c.id}`, c.unreadCount ?? 0]));
}

/** Create a chat (host). Requires share consent — throws ConsentRequiredError otherwise. */
export async function createChat(name: string): Promise<ChatRecord> {
  const me = await ensureMe();
  if (!me) throw new Error('Your Microsoft profile has not loaded yet — check your connection.');
  const record = await chatsApi.createChatFolder(name.trim() || 'Untitled chat', me);
  await db.putChat(record);
  // The creator has read everything there is (nothing); prime notifications.
  await db.putSetting(notifyPrimedKey(`chat:${record.id}`), true);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
  return record;
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
  };

  if (!isOwnChat) {
    await chatsApi.putMemberSelf(record, { v: 1, id: me.id, name: me.name, joinedAt, updatedAt: joinedAt });
    // Roaming pointer in our own approot — best-effort, join succeeds without it.
    await chatsApi.putJoinedPointer({
      v: 1,
      chatId: record.id,
      name: record.name,
      driveId: record.driveId,
      itemId: record.itemId,
      dropsItemId: record.dropsItemId,
      host: record.host,
      joinedAt,
    }).catch(err => console.debug('[Chats] Roaming pointer write failed:', err));
  }

  await db.putChat(record);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
  // The first sync primes notifications (per-scope primed key) so a joined
  // chat's backlog never lands as a notification wall.
  void requestSync(chatScopeOf(record), { force: true });
  return record;
}

/** Guest: leave a chat — best-effort remote cleanup, full local cleanup. */
export async function leaveChat(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record) return;
  if (record.role === 'guest') {
    if (record.state !== 'gone') {
      const me = await ensureMe();
      if (me) await chatsApi.deleteMemberFile(record, me.id).catch(() => {});
    }
    await chatsApi.deleteJoinedPointer(chatId).catch(() => {});
  }
  await db.clearScopeData(`chat:${chatId}`);
  scopeStates.delete(`chat:${chatId}`);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
}

/** Host: delete the chat for everyone (removes the folder from OneDrive). */
export async function deleteChatHosted(chatId: string): Promise<void> {
  const record = await db.getChat(chatId);
  if (!record || record.role !== 'host') return;
  await chatsApi.deleteChatFolder(chatId);
  await db.clearScopeData(`chat:${chatId}`);
  scopeStates.delete(`chat:${chatId}`);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
}

/** Remove a gone chat from the list (local only — access already ended). */
export async function removeChatLocally(chatId: string): Promise<void> {
  await db.clearScopeData(`chat:${chatId}`);
  scopeStates.delete(`chat:${chatId}`);
  emit({ type: 'chats-changed' });
  postBroadcast({ type: 'chats-changed' });
}

let registryHydrated = false;

/**
 * Merge chats discovered in OneDrive into the local registry — chats this
 * account hosts (approot:/chats) and chats it joined elsewhere
 * (approot:/chats-joined roaming pointers). Both live in our own approot,
 * so discovery needs no share consent; syncing a discovered guest chat will
 * surface needs-consent on its own if the grant is missing.
 */
export async function hydrateChatRegistry(): Promise<void> {
  if (registryHydrated) return;
  registryHydrated = true;
  try {
    const me = await ensureMe();
    if (!me) {
      registryHydrated = false;
      return;
    }
    const local = new Set((await db.getAllChats()).map(c => c.id));
    let changed = false;

    for (const record of await chatsApi.listHostChats(me)) {
      if (local.has(record.id)) continue;
      await db.putChat(record);
      changed = true;
    }

    for (const pointer of await chatsApi.listJoinedPointers()) {
      if (local.has(pointer.chatId)) continue;
      await db.putChat({
        id: pointer.chatId,
        name: pointer.name,
        role: 'guest',
        driveId: pointer.driveId,
        itemId: pointer.itemId,
        dropsItemId: pointer.dropsItemId,
        host: pointer.host,
        joinedAt: pointer.joinedAt,
        state: 'active',
      });
      changed = true;
    }

    if (changed) {
      emit({ type: 'chats-changed' });
      postBroadcast({ type: 'chats-changed' });
    }
  } catch (err) {
    registryHydrated = false; // retry on a later call
    console.debug('[Chats] Registry hydration failed:', err);
  }
}
