/**
 * Sync diagnostics — per-pass timings and request counts, kept on the device
 * so the owner can read them on a phone (Settings › Sync diagnostics) without
 * attaching a debugger to an installed app.
 *
 * Only counts, timings and error classes are recorded. Never URLs (Graph
 * download links carry their own auth), drop content, or file names.
 */

import { getAllDeviceProfiles, getScopeDropIds, getSetting, patchSetting } from './db';
import { PRIVATE_SCOPE_ID, type Scope } from '../types';

const STATS_KEY = 'milkbox:sync-stats';
const MAX_PASSES = 20;

/** What one sync pass did, filled in by the Graph layer as it runs. */
export interface PassCounts {
  /** Delta (or listing) pages fetched. */
  pages: number;
  /** Drop items the pages named (upserts and deletes). */
  enumerated: number;
  /** Drop bodies fetched over the network. */
  downloaded: number;
  /** Drop bodies not fetched because this device already held that version. */
  skipped: number;
  /** Bodies fetched through Graph /content because the item had no download link. */
  fallbacks: number;
  /** Body downloads retried after a transient failure. */
  retries: number;
  /** Bodies discarded by validation. */
  malformed: number;
}

export function newPassCounts(): PassCounts {
  return { pages: 0, enumerated: 0, downloaded: 0, skipped: 0, fallbacks: 0, retries: 0, malformed: 0 };
}

export interface PassStats extends PassCounts {
  scope: Scope['kind'];
  mode: 'full' | 'incremental' | 'listing';
  outcome: 'ok' | 'error';
  /** Error class and HTTP status — never a message or URL. */
  error?: string;
  startedAt: number;
  totalMs: number;
  /** Time until the pass first wrote drops to this device. */
  firstCommitMs?: number;
  /** Time the device-profile sync took (private feed only). */
  devicesMs?: number;
  /** Device profiles held after the pass (private feed only). */
  devices?: number;
  /** Drops removed from this device. */
  removed: number;
  /**
   * Network requests started while the pass ran. Process-wide, so a chat
   * syncing at the same time is counted here too.
   */
  requests: number;
}

export interface SyncStatsLog {
  passes: PassStats[];
  /** Kept apart from the rolling list: the number that matters most on a phone. */
  lastFull?: PassStats;
}

// ─── process-wide counters ───

/** Since this page loaded. */
export const counters = {
  /** Authenticated requests to graph.microsoft.com. */
  graph: 0,
  /** Pre-authenticated requests to OneDrive's content host. */
  storage: 0,
  /** 429/503 responses. */
  throttles: 0,
  /** Requests abandoned by a timeout. */
  timeouts: 0,
  /** MSAL token-cache snapshots written to IndexedDB. */
  backups: 0,
};

export function requestCount(): number {
  return counters.graph + counters.storage;
}

/** "HTTP 429", "TimeoutError", "TypeError" — enough to tell failures apart. */
export function errorLabel(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `HTTP ${status}`;
  // `name`, not the constructor's: a production build minifies class names.
  if (err instanceof Error || err instanceof DOMException) return err.name || 'Error';
  return 'Unknown';
}

// ─── the log ───

export async function recordPass(stats: PassStats): Promise<void> {
  console.info(
    '[SyncStats] %s %s %s in %d ms — %d downloaded, %d skipped, %d requests%s',
    stats.scope,
    stats.mode,
    stats.outcome,
    Math.round(stats.totalMs),
    stats.downloaded,
    stats.skipped,
    stats.requests,
    stats.error ? ` (${stats.error})` : '',
  );
  await patchSetting<SyncStatsLog>(STATS_KEY, current => ({
    passes: [...(current?.passes ?? []), stats].slice(-MAX_PASSES),
    // The private feed's only: the panel pairs it with the private drop
    // count, and a small chat joined later shouldn't replace the figure.
    lastFull:
      stats.scope === 'private' && stats.mode === 'full' && stats.outcome === 'ok' ? stats : current?.lastFull,
  }));
}

export async function getSyncStats(): Promise<SyncStatsLog> {
  return (await getSetting<SyncStatsLog>(STATS_KEY)) ?? { passes: [] };
}

export interface Diagnostics extends SyncStatsLog {
  /** Private drops held on this device. */
  drops: number;
  /** Device profiles held on this device. */
  devices: number;
  sinceLaunch: typeof counters;
}

export async function getDiagnostics(): Promise<Diagnostics> {
  const [log, dropIds, profiles] = await Promise.all([
    getSyncStats(),
    getScopeDropIds(PRIVATE_SCOPE_ID),
    getAllDeviceProfiles(),
  ]);
  return { ...log, drops: dropIds.length, devices: profiles.length, sinceLaunch: { ...counters } };
}
