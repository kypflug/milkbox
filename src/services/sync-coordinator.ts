/**
 * Sync coordinator — the single owner of sync and outbox state.
 *
 * Responsibilities:
 * - Serialized sync passes (never two delta runs in flight)
 * - A persistent outbox: optimistic sends that survive reloads, with
 *   exponential backoff and Retry-After handling
 * - Feed assembly: IDB drops + pending outbox overlays
 * - Event pub/sub — the UI subscribes; this module never touches the DOM
 */

import type { DeviceProfile, DropMeta, DropRecord, OutboxRecord } from '../types';
import * as db from './db';
import * as graph from './graph';
import * as device from './device';
import * as notify from './notify';
import { postBroadcast } from './broadcast';

export type CoordinatorEvent =
  | { type: 'sync-start' }
  | { type: 'sync-complete' }
  | { type: 'sync-error'; error: unknown }
  | { type: 'feed-updated' }
  | { type: 'drop-progress'; dropId: string; fraction: number };

type Handler = (event: CoordinatorEvent) => void;

const handlers = new Set<Handler>();
const PENDING_DEVICE_PROFILE_KEY = 'milkbox:pending-device-profile';
/** Set once the first sync pass lands, so a fresh sign-in isn't announced. */
const NOTIFY_PRIMED_KEY = 'milkbox:notify-primed';

export function onCoordinatorEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function emit(event: CoordinatorEvent): void {
  for (const h of handlers) h(event);
}

// ─── feed assembly ───

/**
 * The rendered feed: synced drops from IDB with pending outbox records
 * overlaid (an outbox create shows as 'sending'/'failed'; an outbox delete
 * hides the drop before the server confirms). Sorted by ULID — newest last.
 */
export async function loadFeed(): Promise<DropRecord[]> {
  const [drops, outbox] = await Promise.all([db.getAllDrops(), db.getOutbox()]);
  const byId = new Map<string, DropRecord>();
  for (const d of drops) byId.set(d.meta.id, { ...d, state: undefined });
  for (const o of outbox) {
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
  emit({ type: 'feed-updated' });
  void requestSync({ force: true });
}

// ─── outbox ───

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;

/** Queue a new drop (optionally with a file payload) and start draining. */
export async function enqueueCreate(meta: DropMeta, blob?: Blob): Promise<void> {
  await db.putOutboxRecord({
    id: meta.id,
    meta,
    blob,
    op: 'create',
    attempts: 0,
    state: 'queued',
  });
  emit({ type: 'feed-updated' });
  void requestSync({ force: true });
}

/** Queue an edit to an existing text drop. */
export async function enqueueEdit(meta: DropMeta): Promise<void> {
  await db.putOutboxRecord({ id: meta.id, meta, op: 'edit', attempts: 0, state: 'queued' });
  // Optimistically update the local record so the edit shows immediately
  const existing = await db.getDrop(meta.id);
  if (existing) await db.putDrop({ ...existing, meta });
  emit({ type: 'feed-updated' });
  void drainOutbox();
}

/** Queue a delete. The feed hides the drop immediately. */
export async function enqueueDelete(id: string): Promise<void> {
  const existing = await db.getDrop(id);
  const meta = existing?.meta;
  if (!meta) {
    // Drop only exists in the outbox (never synced) — just cancel it
    await db.deleteOutboxRecord(id);
    emit({ type: 'feed-updated' });
    return;
  }
  await db.putOutboxRecord({ id, meta, op: 'delete', attempts: 0, state: 'queued' });
  emit({ type: 'feed-updated' });
  void drainOutbox();
}

/** Retry a failed outbox record. */
export async function retryOutboxRecord(id: string): Promise<void> {
  const records = await db.getOutbox();
  const record = records.find(r => r.id === id);
  if (!record) return;
  await db.putOutboxRecord({ ...record, attempts: 0, state: 'queued' });
  emit({ type: 'feed-updated' });
  void drainOutbox();
}

/** Discard a failed outbox record entirely. */
export async function discardOutboxRecord(id: string): Promise<void> {
  await db.deleteOutboxRecord(id);
  emit({ type: 'feed-updated' });
}

let draining = false;

/**
 * Drain the outbox serially. Each record gets MAX_ATTEMPTS tries with
 * exponential backoff; throttle responses (429/503) pause the whole drain
 * for the server-requested interval.
 */
export async function drainOutbox(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    let records = await db.getOutbox();
    // Oldest first so the feed lands in order
    records.sort((a, b) => (a.id < b.id ? -1 : 1));

    for (const record of records) {
      if (record.state === 'failed') continue;
      await processOutboxRecord(record);
    }
  } finally {
    draining = false;
  }
}

async function processOutboxRecord(record: OutboxRecord): Promise<void> {
  let attempts = record.attempts;
  while (attempts < MAX_ATTEMPTS) {
    try {
      await db.putOutboxRecord({ ...record, attempts, state: 'sending' });
      await performOp(record);
      await db.deleteOutboxRecord(record.id);
      emit({ type: 'feed-updated' });
      postBroadcast({
        type: 'drop-mutated',
        dropId: record.id,
        action: record.op === 'delete' ? 'delete' : 'upsert',
      });
      return;
    } catch (err) {
      attempts++;
      const throttled = graph.isThrottleError(err);
      const retryAfter =
        throttled && err instanceof graph.GraphHttpError && err.retryAfterSeconds
          ? err.retryAfterSeconds * 1000
          : BACKOFF_BASE_MS * 2 ** (attempts - 1);
      console.warn('[Outbox] %s %s failed (attempt %d):', record.op, record.id, attempts, err);
      if (attempts >= MAX_ATTEMPTS) {
        await db.putOutboxRecord({ ...record, attempts, state: 'failed' });
        emit({ type: 'feed-updated' });
        return;
      }
      await new Promise(r => setTimeout(r, retryAfter));
    }
  }
}

async function performOp(record: OutboxRecord): Promise<void> {
  if (record.op === 'delete') {
    await graph.deleteDropJson(record.id);
    if (record.meta.file) await graph.deleteDropFiles(record.id);
    await db.deleteDrop(record.id);
    await db.deleteThumb(record.id).catch(() => {});
    await db.deleteCachedBlob(record.id).catch(() => {});
    return;
  }

  const meta = { ...record.meta };

  if (record.op === 'create' && meta.file && record.blob) {
    // Blob first, then JSON — other devices never see a dangling reference
    const uploaded = await graph.uploadDropFile(meta, record.blob, {
      existingSessionUrl: record.uploadUrl,
      onSessionCreated: uploadUrl => {
        // Persist so a reloaded tab resumes instead of restarting
        void db.putOutboxRecord({ ...record, uploadUrl });
      },
      onProgress: fraction => emit({ type: 'drop-progress', dropId: meta.id, fraction }),
    });
    meta.file = { ...meta.file, itemId: uploaded.itemId };
  }

  const existing = record.op === 'edit' ? await db.getDrop(meta.id) : undefined;
  const eTag = await graph.putDropJson(meta, existing?.eTag);
  await db.putDrop({ meta, eTag });

  // Cache the local payload as the image blob so the sender gets an
  // instant render without a round-trip
  if (meta.kind === 'image' && record.blob) {
    await db.putCachedBlob(meta.id, record.blob).catch(() => {});
  }
}

// ─── sync ───

let syncing = false;
let syncPromise: Promise<void> | null = null;
let syncAgain = false;
let lastSyncAt = 0;
const SYNC_FLOOR_MS = 5_000;

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
    emit({ type: 'feed-updated' });
    postBroadcast({ type: 'sync-complete' });
  }
  return snapshot.cTag;
}

/**
 * Pick out the upserts this device has never held before.
 *
 * Novelty is presence in IDB, not id order. ULIDs are minted when a drop is
 * composed but only published when the author's outbox drains, so a drop
 * queued offline — or one whose blob upload was slow, retried, or resumed —
 * routinely surfaces with an id older than drops already seen. A high-water
 * mark would skip those forever.
 *
 * Must be called before the pass writes upserts to IDB.
 */
async function collectArrivals(upserts: DropRecord[]): Promise<DropMeta[]> {
  if (!upserts.length || !notify.isNotifyEnabled()) return [];

  // Our own sends are already in IDB by the time the delta echoes them back,
  // so presence would filter them anyway — but checking first usually skips
  // the read entirely, since sending is what triggers the next pass.
  const deviceId = device.getDeviceId();
  const candidates = upserts.filter(record => record.meta.device.id !== deviceId);
  if (!candidates.length) return [];

  const known = new Set(await db.getAllDropIds());
  return candidates
    .filter(record => !known.has(record.meta.id))
    .map(record => record.meta)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Announce drops that arrived from another device.
 *
 * The first completed pass on an install only primes: a fresh sign-in reads
 * the entire existing feed as new, and announcing it would be a wall of
 * notifications. Priming has to happen even when that pass found nothing,
 * or the first drop the account ever receives would be mistaken for backlog.
 */
async function announceArrivals(arrivals: DropMeta[]): Promise<void> {
  const primed = await db.getSetting<boolean>(NOTIFY_PRIMED_KEY);
  if (!primed) {
    await db.putSetting(NOTIFY_PRIMED_KEY, true);
    return;
  }
  if (!arrivals.length) return;

  const profiles = await db.getAllDeviceProfiles();
  const names = new Map(profiles.map(profile => [profile.id, profile.name]));
  await notify.announceDrops(arrivals, names);
}

/**
 * Run a sync pass: drain the outbox, then delta the drops folder into IDB.
 * Serialized and rate-floored; safe to call from every trigger.
 */
export function requestSync(opts: { force?: boolean } = {}): Promise<void> {
  if (syncPromise) {
    if (opts.force) syncAgain = true;
    return syncPromise;
  }
  const now = Date.now();
  if (!opts.force && now - lastSyncAt < SYNC_FLOOR_MS) return Promise.resolve();
  syncPromise = runSync();
  return syncPromise;
}

async function runSync(): Promise<void> {
  syncing = true;
  try {
    do {
      syncAgain = false;
      lastSyncAt = Date.now();
      emit({ type: 'sync-start' });

      try {
        let deviceCTag: string | undefined;
        try {
          deviceCTag = await syncDeviceProfiles();
        } catch (err) {
          console.warn('[Sync] Device profile sync failed; continuing with drops:', err);
        }
        await drainOutbox();

        const result = await graph.runDelta();

        // Snapshot novelty before the writes below land — afterwards every
        // upsert is present in IDB and indistinguishable from one we held.
        const arrivals = await collectArrivals(result.upserts);

        if (result.fullResync) {
          // Reconcile: the delta pass IS the complete server state. Drop local
          // records absent from it (except outbox pendings, which overlay anyway).
          const records = result.upserts;
          await db.replaceAllDrops(records);
        } else {
          for (const record of result.upserts) await db.putDrop(record);
          for (const id of result.removals) {
            await db.deleteDrop(id);
            await db.deleteThumb(id).catch(() => {});
            await db.deleteCachedBlob(id).catch(() => {});
          }
        }

        await graph.markFeedClean();
        if (deviceCTag) await graph.markDeviceRegistryClean(deviceCTag);

        try {
          await announceArrivals(arrivals);
        } catch (err) {
          console.warn('[Sync] Announcing arrivals failed; drops are synced:', err);
        }

        if (result.upserts.length || result.removals.length || result.fullResync) {
          emit({ type: 'feed-updated' });
          postBroadcast({ type: 'sync-complete' });
        }
        emit({ type: 'sync-complete' });
      } catch (err) {
        console.warn('[Sync] Sync pass failed:', err);
        emit({ type: 'sync-error', error: err });
      }
    } while (syncAgain);
  } finally {
    syncing = false;
    syncPromise = null;
  }
}

/**
 * Cheap poll tick: ask the folder cTag whether anything changed before
 * paying for a delta pass. Also drains any queued outbox work.
 */
export async function pollTick(): Promise<void> {
  if (syncing) return;
  try {
    const outbox = await db.getOutbox();
    const pendingProfile = await db.getSetting<DeviceProfile>(PENDING_DEVICE_PROFILE_KEY);
    if (pendingProfile || outbox.some(r => r.state !== 'failed')) {
      await requestSync({ force: true });
      return;
    }
    const [feedDirty, devicesDirty] = await Promise.all([
      graph.isFeedDirty(),
      graph.isDeviceRegistryDirty(),
    ]);
    if (feedDirty || devicesDirty) {
      await requestSync({ force: true });
    }
  } catch (err) {
    console.debug('[Sync] Poll tick failed:', err);
  }
}

/** Re-read the feed from IDB after another tab synced (no network). */
export function refreshFromCache(): void {
  emit({ type: 'feed-updated' });
}
