/**
 * Microsoft Graph client for Milkbox — hand-rolled fetch against the
 * OneDrive App Folder (approot). No SDK; the surface we use is small.
 *
 * Layout in the user's OneDrive (appears as Apps/Milkbox):
 *   drops/<ulid>.json     — one small JSON per drop; the delta scope
 *   devices/<uuid>.json   — one current profile per browser installation
 *   files/<ulid>/<name>   — binary payloads, outside the delta scope
 *
 * The split keeps multi-MB uploads out of the delta stream: every delta
 * item is a JSON we always download.
 */

import { getAccessToken, type TokenTier } from './auth';
import { getSetting, putSetting, deleteSetting } from './db';
import { validateDropMeta } from './validate-drop';
import { counters, type PassCounts } from './sync-stats';
import { createLimiter, mapLimited } from '../utils/limit';
import { scopeIdOf, type DeviceProfile, type DropMeta, type DropRecord, type Scope } from '../types';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DROPS_FOLDER = 'drops';
const DEVICES_FOLDER = 'devices';
const DEVICES_CTAG_KEY = 'milkbox:devices-ctag';

/** Settings keys a sync pass commits together with the drops they describe. */
export const deltaTokenKey = (scope: Scope) => `milkbox:delta-token:${scopeIdOf(scope)}`;
export const folderCtagKey = (scope: Scope) => `milkbox:ctag:${scopeIdOf(scope)}`;

/**
 * How long a JSON request (a listing, a delta page, a drop body) may take.
 * iOS can leave a request hanging when it suspends a backgrounded app; without
 * a limit that one request would hold its scope's sync until a relaunch.
 * Byte transfers (uploads, file downloads) are exempt — they can legitimately
 * run longer on a slow connection.
 */
const JSON_TIMEOUT_MS = 20_000;
/**
 * Delta and listing pages carry hundreds of items each, and the limit covers
 * the whole response, body included. They run one at a time and are already
 * abortable, so a budget a slow cellular link can meet costs nothing — a
 * page that keeps timing out would restart the enumeration every time.
 */
export const PAGE_TIMEOUT_MS = 60_000;
/**
 * Thumbnail bytes are a file transfer too, but a bounded one (a preview
 * image), and a hung one would hold one of the few preview slots until a
 * relaunch — so they get a limit of their own, generous for a slow link.
 */
const THUMBNAIL_TIMEOUT_MS = 60_000;

/**
 * A time limit for one request, response body included.
 *
 * fetch() resolves as soon as the headers arrive, so the limit has to cover
 * reading the body too — and a read cut short by it does not reliably say
 * so: it can reject with a bare AbortError rather than the TimeoutError the
 * signal was aborted with. `fail` settles that in one place.
 *
 * The limit starts when the request is sent. Getting an access token first
 * (MSAL, in graphFetch) is outside it.
 */
interface Deadline {
  signal: AbortSignal;
  /**
   * Rethrow `err`, classified by what actually happened:
   * - this deadline ended the request: a TimeoutError, counted for diagnostics;
   * - an AbortError nobody asked for (some engines report a connection lost
   *   mid-body that way): a network error, like any other dropped connection;
   * - anything else, a deliberate abort included: unchanged.
   * The retry logic treats timeouts and network errors as transient; an
   * unexplained abort it would not.
   */
  fail(err: unknown): never;
}

/** A deadline of `ms` (the JSON timeout by default) that `outer` can also end early. */
function deadline(outer?: AbortSignal | null, ms = JSON_TIMEOUT_MS): Deadline {
  if (import.meta.env.DEV && devFaults.timeoutMs > 0) ms = devFaults.timeoutMs;
  let timeout: AbortSignal;
  if (typeof AbortSignal.timeout === 'function') {
    timeout = AbortSignal.timeout(ms);
  } else {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
    timeout = controller.signal;
  }
  let signal = timeout;
  if (outer) {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([outer, timeout]);
    } else {
      const combined = new AbortController();
      const forward = (from: AbortSignal) => () => combined.abort(from.reason);
      if (outer.aborted) combined.abort(outer.reason);
      outer.addEventListener('abort', forward(outer), { once: true });
      timeout.addEventListener('abort', forward(timeout), { once: true });
      signal = combined.signal;
    }
  }
  return {
    signal,
    fail(err) {
      if (timeout.aborted && !outer?.aborted) {
        counters.timeouts++;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }
      if (err instanceof DOMException && err.name === 'AbortError' && !outer?.aborted) {
        throw new TypeError('Network error while reading the response');
      }
      throw err;
    },
  };
}

/** Simple PUT limit — Graph requires upload sessions above 4 MB. */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Upload session chunk size — must be a multiple of 320 KiB. */
const CHUNK_SIZE = 10 * 1024 * 1024;

export class GraphHttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    message?: string,
    public retryAfterSeconds?: number,
  ) {
    super(message || `Graph request failed: ${status}`);
  }
}

export function isGoneError(err: unknown): boolean {
  return err instanceof GraphHttpError && (err.status === 404 || err.status === 410);
}

export function isThrottleError(err: unknown): boolean {
  return err instanceof GraphHttpError && (err.status === 429 || err.status === 503);
}

async function authHeaders(tier: TokenTier): Promise<Record<string, string>> {
  const token = await getAccessToken(tier);
  return { Authorization: `Bearer ${token}` };
}

export interface GraphInit extends RequestInit {
  /** Moves file bytes — skip the JSON timeout. */
  noTimeout?: boolean;
  /** A limit other than the JSON one (a paged listing, a preview image). */
  timeoutMs?: number;
}

/** Statuses whose responses carry no body (and may not be rebuilt with one). */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * One authenticated Graph request. `read` consumes the response inside the
 * request's deadline (when it has one), so the limit covers the body and a
 * stall there is counted and classified like any other timeout.
 */
async function graphRequest<T>(
  url: string,
  init: GraphInit | undefined,
  tier: TokenTier,
  read: (res: Response, limited: boolean) => Promise<T>,
): Promise<T> {
  // Before the token is asked for: a request for a pass that has been
  // stopped (a sign-out, a reset) starts no auth work.
  if (init?.signal?.aborted) throw init.signal.reason;
  const headers = await authHeaders(tier);
  counters.graph++;
  const { noTimeout, timeoutMs, ...request } = init ?? {};
  const limit: Deadline | null = noTimeout ? null : deadline(request.signal, timeoutMs);
  try {
    const res = await fetch(url, {
      ...request,
      signal: limit ? limit.signal : request.signal,
      headers: { ...headers, ...(request.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      if (res.status === 429 || res.status === 503) counters.throttles++;
      const retryAfter = res.headers.get('Retry-After');
      throw new GraphHttpError(
        res.status,
        url,
        undefined,
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      );
    }
    return await read(res, limit !== null);
  } catch (err) {
    // An HTTP error is an answer, not a failed request: never reclassified.
    if (limit && !(err instanceof GraphHttpError)) return limit.fail(err);
    throw err;
  }
}

export function graphFetch(url: string, init?: GraphInit, tier: TokenTier = 'base'): Promise<Response> {
  return graphRequest(url, init, tier, async (res, limited) => {
    if (!limited) return res;
    // Read the body here, under the limit, and hand back a response that
    // already holds it: callers go on to res.json() and the like, and a
    // stall there would be outside anything that could time it or retry it.
    // (For the small JSON these requests carry. A file goes through
    // downloadDropFile, which reads its bytes straight into a Blob.)
    const body = await res.arrayBuffer();
    return new Response(NULL_BODY_STATUS.has(res.status) ? null : body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  });
}

/**
 * Fetch from OneDrive's content host — a pre-authenticated download or
 * upload-session URL, so no token. Counted apart from Graph calls. Untimed:
 * upload chunks use it as is, and reads that want a limit go through
 * storageRead.
 */
export function storageFetch(url: string, init?: RequestInit): Promise<Response> {
  counters.storage++;
  return fetch(url, init);
}

/**
 * Fetch from the content host and consume the response with `read`, all of
 * it under one deadline — the body as much as the headers.
 */
async function storageRead<T>(url: string, limit: Deadline, read: (res: Response) => Promise<T>): Promise<T> {
  try {
    return await read(await storageFetch(url, { signal: limit.signal }));
  } catch (err) {
    limit.fail(err);
  }
}

// ─── DEV fault injection ───

/**
 * Make drop-body downloads slow or flaky on purpose, to exercise interrupted
 * and retried passes on a desktop. Driven from window.__milkboxChatDev; the
 * hook below compiles to nothing in production builds.
 */
const devFaults = {
  bodyFailRate: 0,
  bodyDelayMs: 0,
  /** Replaces every request time limit, so timeouts can be tested without waiting for them. */
  timeoutMs: 0,
};

export function setDevFaults(faults: Partial<typeof devFaults>): void {
  Object.assign(devFaults, faults);
}

async function injectBodyFault(): Promise<void> {
  if (!import.meta.env.DEV) return;
  if (devFaults.bodyDelayMs > 0) await new Promise(r => setTimeout(r, devFaults.bodyDelayMs));
  if (Math.random() < devFaults.bodyFailRate) throw new TypeError('Injected network failure');
}

// ─── small JSON bodies ───

/**
 * A non-OK answer from OneDrive's content host to a pre-authenticated
 * download. Kept apart from GraphHttpError on purpose: an expired download
 * link (401/403/404) says nothing about access to a chat, so it must never
 * count toward a chat being "gone" — the next pass simply mints fresh links.
 * The link itself is never kept: it carries its own auth.
 */
export class DownloadError extends Error {
  constructor(public status: number) {
    super(`Download failed: ${status}`);
  }
}

/** Every JSON body download, across all scopes, shares these slots. */
const bodyLimiter = createLimiter(6);
const BODY_RETRY_DELAYS_MS = [500, 2000];

/**
 * Wait out a retry's delay, or reject the moment `signal` aborts. A retry
 * that has been called off must not sit the delay out and then start again:
 * through Graph /content the next attempt asks for a token before it looks
 * at the signal, which is work for a pass that a sign-out or a reset has
 * already stopped, and keeps that pass alive meanwhile.
 */
function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A dropped connection, a timeout or a server hiccup — worth a quick retry. */
function isRetryableBodyError(err: unknown): boolean {
  if (err instanceof DownloadError || err instanceof GraphHttpError) {
    return err.status >= 500 && err.status !== 503;
  }
  if (err instanceof DOMException) return err.name === 'TimeoutError';
  return err instanceof TypeError; // fetch's network failure
}

export interface JsonItem {
  id: string;
  '@microsoft.graph.downloadUrl'?: string;
}

/**
 * Download one small JSON file (a drop, a device profile, a member file):
 * through the item's pre-authenticated link when its listing carried one,
 * else through Graph /content — a redirect plus a token, counted as a
 * fallback in diagnostics. Transient failures retry twice; 429/503 surface
 * as GraphHttpError so the coordinator's throttle gate applies.
 */
export function downloadItemJson(
  item: JsonItem,
  fallbackUrl: string,
  tier: TokenTier,
  opts: { signal?: AbortSignal; stats?: PassCounts } = {},
): Promise<unknown> {
  return bodyLimiter(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchJsonBody(item, fallbackUrl, tier, opts);
      } catch (err) {
        const delay = BODY_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || opts.signal?.aborted || !isRetryableBodyError(err)) throw err;
        if (opts.stats) opts.stats.retries++;
        await retryDelay(delay, opts.signal);
      }
    }
  }, opts.signal);
}

async function fetchJsonBody(
  item: JsonItem,
  fallbackUrl: string,
  tier: TokenTier,
  opts: { signal?: AbortSignal; stats?: PassCounts },
): Promise<unknown> {
  await injectBodyFault();
  const link = item['@microsoft.graph.downloadUrl'];
  if (!link) {
    if (opts.stats) opts.stats.fallbacks++;
    const res = await graphFetch(fallbackUrl, { signal: opts.signal }, tier);
    return parseJsonBody(await res.text());
  }
  const text = await storageRead(link, deadline(opts.signal), async res => {
    if (!res.ok) {
      if (res.status === 429 || res.status === 503) throw contentThrottleError(res);
      throw new DownloadError(res.status);
    }
    return res.text();
  });
  return parseJsonBody(text);
}

/**
 * A body that arrived whole but isn't JSON (an empty or truncated file) is
 * that one file's problem: it comes back undefined, which every caller's
 * validation discards. Thrown instead, it would fail the whole pass — and
 * every pass after it, since each would meet the same file again. A body
 * that failed to arrive still throws, from the read above.
 */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A 429/503 from the content host, as the error the coordinator's throttle
 * gate understands. Retry-After is honoured when the host exposes it.
 */
function contentThrottleError(res: Response): GraphHttpError {
  counters.throttles++;
  const retryAfter = parseInt(res.headers.get('Retry-After') ?? '', 10);
  return new GraphHttpError(res.status, 'content host', undefined, Number.isFinite(retryAfter) ? retryAfter : 30);
}

/**
 * Where a scope's folder tree is addressed. The private feed lives in the
 * signed-in user's own approot; a chat folder lives in the HOST's drive and
 * is addressed by drive + item id (the only stable form for shared items).
 * Both use the same relative paths (drops/…, files/…) below the root.
 */
export type DriveRef =
  | { kind: 'approot' }
  | { kind: 'item'; driveId: string; itemId: string };

function scopeRef(scope: Scope): DriveRef {
  return scope.kind === 'private'
    ? { kind: 'approot' }
    : { kind: 'item', driveId: scope.driveId, itemId: scope.itemId };
}

/** Chat traffic crosses drives, which the app-folder scope cannot reach. */
export function scopeTier(scope: Scope): TokenTier {
  return scope.kind === 'private' ? 'base' : 'share';
}

function rootUrl(ref: DriveRef): string {
  return ref.kind === 'approot'
    ? `${GRAPH_BASE}/me/drive/special/approot`
    : `${GRAPH_BASE}/drives/${ref.driveId}/items/${ref.itemId}`;
}

export function contentUrl(ref: DriveRef, path: string): string {
  return `${rootUrl(ref)}:/${path}:/content`;
}

export function itemByPathUrl(ref: DriveRef, path: string): string {
  return `${rootUrl(ref)}:/${path}`;
}

const APPROOT: DriveRef = { kind: 'approot' };

const dropJsonPath = (id: string) => `${DROPS_FOLDER}/${id}.json`;
const deviceJsonPath = (id: string) => `${DEVICES_FOLDER}/${id}.json`;

// ─── drop JSON CRUD ───

/**
 * Thrown when a chat-scope edit loses its conditional write — the drop was
 * changed or removed by another member. Terminal: the caller must drop the
 * queued edit, never retry (an unconditional retry would resurrect a drop
 * the host moderated away).
 */
export class DropConflictError extends Error {
  constructor(public dropId: string) {
    super(`Drop ${dropId} was changed or removed`);
  }
}

/**
 * Thrown when a private-feed edit finds its drop gone — deleted on another
 * device while the edit waited to be sent. Terminal, like a chat's conflict:
 * the delete stands, and the caller drops the queued edit.
 */
export class DropGoneError extends Error {
  constructor(public dropId: string) {
    super(`Drop ${dropId} was deleted`);
  }
}

/**
 * Upload a drop's JSON. Path-based PUT auto-creates the drops/ folder (and
 * the approot itself) on first write. Pass eTag for a conditional write on
 * edits. Conflict handling differs by scope:
 * - private: write once more, last write wins — the data is single-user,
 *   conflicts are self-races — but only over a drop that is still there.
 *   The second write is conditional too, on the version OneDrive holds by
 *   then, read for the purpose: sent with no condition it would create the
 *   file, and an edit must not bring back a drop that has been deleted.
 *   With no version to write over, the edit ends in DropGoneError.
 *   `beforeRetry` is awaited before that second write, and calls it off by
 *   throwing: the write that lost can have been out for a long time, and
 *   what it lost to may be the caller's own newer write (see performOp),
 *   which last-write-wins would undo. All of this only with an eTag: with
 *   none the write is a create, so performOp sends no private edit that
 *   way, and reads a version for one that has none (currentDropETag);
 * - chat: strictly conditional — 412/404 becomes DropConflictError so a
 *   queued edit can never recreate a drop another member deleted.
 */
export async function putDropJson(
  scope: Scope,
  meta: DropMeta,
  eTag?: string,
  beforeRetry?: () => Promise<void>,
): Promise<string | undefined> {
  const ref = scopeRef(scope);
  const tier = scopeTier(scope);
  const body = JSON.stringify(meta, null, 2);
  const doPut = (ifMatch?: string) =>
    graphFetch(contentUrl(ref, dropJsonPath(meta.id)), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(ifMatch ? { 'If-Match': ifMatch } : {}),
      },
      body,
    }, tier);

  try {
    const res = await doPut(eTag);
    const item = await res.json();
    return item.eTag as string | undefined;
  } catch (err) {
    if (err instanceof GraphHttpError && (err.status === 412 || (eTag !== undefined && err.status === 404))) {
      if (scope.kind === 'chat') throw new DropConflictError(meta.id);
      // A write sent with no condition (a create) has none to lose. Its
      // failure is an ordinary one, not a reason to look for a version to
      // write over — or to conclude, finding none, that the drop was deleted.
      if (eTag === undefined) throw err;
      const current = await currentDropETag(scope, meta.id);
      // Asked after the read, not before: the read is a request too, and can
      // be out as long as the first write was. Whatever the caller sends
      // from here on lands after the read. If it lands before this write,
      // the drop has moved on from the version the condition names, and
      // this write fails rather than replace it.
      await beforeRetry?.();
      if (current === null) throw new DropGoneError(meta.id);
      console.debug('[Graph] eTag conflict on %s — retrying last-write-wins', meta.id);
      // If this one loses as well, that is the caller's ordinary failure:
      // its next attempt starts over from the first write.
      const res = await doPut(current);
      const item = await res.json();
      return item.eTag as string | undefined;
    }
    throw err;
  }
}

/**
 * Whether the scope holds a JSON for this drop. Only "not found" says it
 * does not (a 404, or a 410: see isGoneError). Every other failure throws,
 * so a caller deciding what may be deleted never reads a request that failed
 * as a drop that is absent.
 */
export async function hasDropJson(scope: Scope, id: string): Promise<boolean> {
  try {
    await graphFetch(`${itemByPathUrl(scopeRef(scope), dropJsonPath(id))}?$select=id`, undefined, scopeTier(scope));
    return true;
  } catch (err) {
    if (isGoneError(err)) return false;
    throw err;
  }
}

/**
 * The eTag a drop's JSON is at now, or null when the scope holds none. As
 * with hasDropJson, only a 404 says that: every other failure throws. What
 * a private edit is made conditional on when the version it was made on is
 * no longer the one to name — its condition was lost — or was never known.
 */
export async function currentDropETag(scope: Scope, id: string): Promise<string | null> {
  try {
    const res = await graphFetch(`${itemByPathUrl(scopeRef(scope), dropJsonPath(id))}?$select=eTag`, undefined, scopeTier(scope));
    const item = await res.json();
    // An answer without one must not pass for a condition: sent with none,
    // the write this is read for would create the file.
    if (typeof item.eTag !== 'string' || !item.eTag) throw new Error(`No eTag for drop ${id}`);
    return item.eTag;
  } catch (err) {
    if (isGoneError(err)) return null;
    throw err;
  }
}

/** Delete a drop's JSON. 404 = already gone = success. */
export async function deleteDropJson(scope: Scope, id: string): Promise<void> {
  try {
    await graphFetch(itemByPathUrl(scopeRef(scope), dropJsonPath(id)), { method: 'DELETE' }, scopeTier(scope));
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

/** Delete a drop's files/<id> folder (file/image drops). 404 = success. */
export async function deleteDropFiles(scope: Scope, id: string): Promise<void> {
  try {
    await graphFetch(itemByPathUrl(scopeRef(scope), `files/${id}`), { method: 'DELETE' }, scopeTier(scope));
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

// ─── device profiles ───

export async function putDeviceProfile(profile: DeviceProfile, signal?: AbortSignal): Promise<void> {
  await graphFetch(contentUrl(APPROOT, deviceJsonPath(profile.id)), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile, null, 2),
    signal,
  });
}

interface GraphFileItem {
  id: string;
  name?: string;
  file?: object;
  '@microsoft.graph.downloadUrl'?: string;
}

export interface DeviceProfileSnapshot {
  /** Absent when the registry's cTag still matched `skipIfCTag` — nothing was listed. */
  profiles?: DeviceProfile[];
  /** Read before the listing, so a change landing mid-listing stays dirty. */
  cTag?: string;
}

/** The devices/ cTag recorded after the last completed listing. */
export function getKnownDeviceRegistryCTag(): Promise<string | undefined> {
  return getSetting<string>(DEVICES_CTAG_KEY);
}

/**
 * List every device profile. Pass the cTag recorded after the last listing
 * as `skipIfCTag` and an unchanged registry costs one tiny GET instead of a
 * listing plus a download per profile — and every reinstall adds a profile.
 * `signal` stops it between requests and ends the one in flight.
 */
export async function listDeviceProfiles(skipIfCTag?: string, signal?: AbortSignal): Promise<DeviceProfileSnapshot> {
  let cTag: string | undefined;
  try {
    const folderRes = await graphFetch(`${itemByPathUrl(APPROOT, DEVICES_FOLDER)}?$select=cTag`, { signal });
    const folder = await folderRes.json();
    cTag = folder.cTag as string | undefined;
  } catch (err) {
    if (isGoneError(err)) return { profiles: [] };
    throw err;
  }
  if (skipIfCTag && cTag === skipIfCTag) return { cTag };

  const start = `${itemByPathUrl(APPROOT, DEVICES_FOLDER)}:/children?$select=id,name,file,@microsoft.graph.downloadUrl`;
  let url = start;
  const items: GraphFileItem[] = [];

  while (url) {
    let data: { value: GraphFileItem[]; '@odata.nextLink'?: string };
    try {
      const res = await graphFetch(url, { timeoutMs: PAGE_TIMEOUT_MS, signal });
      data = await res.json();
    } catch (err) {
      // Only the opening request can say the folder is gone (deleted since
      // its cTag was read). "Gone" on a later page is a listing that broke
      // off: reported as no profiles, it would replace every stored profile
      // with this device's alone and mark the registry clean, and the others
      // would stay away until the folder next changed. So it fails the
      // listing instead, as runDelta does for drops.
      if (url === start && isGoneError(err)) return { profiles: [], cTag };
      throw err;
    }
    items.push(...data.value.filter(item => item.file && item.name?.endsWith('.json')));
    url = data['@odata.nextLink'] || '';
  }

  const downloaded = await mapLimited(
    items,
    4,
    async item =>
      (await downloadItemJson(item, `${GRAPH_BASE}/me/drive/items/${item.id}/content`, 'base', {
        signal,
      })) as DeviceProfile,
    signal,
  );

  const profiles = downloaded.filter(
    profile =>
      profile?.v === 1 &&
      profile.id &&
      profile.name &&
      Number.isFinite(profile.createdAt) &&
      Number.isFinite(profile.updatedAt),
  );
  return { profiles, cTag };
}

// ─── file upload ───

export interface UploadedItem {
  itemId: string;
}

/** Upload a blob ≤ 4 MB in one PUT. */
async function uploadSmallFile(scope: Scope, path: string, blob: Blob): Promise<UploadedItem> {
  const res = await graphFetch(contentUrl(scopeRef(scope), path), {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    noTimeout: true,
  }, scopeTier(scope));
  const item = await res.json();
  return { itemId: item.id };
}

export interface UploadSessionState {
  uploadUrl: string;
}

/** Create a resumable upload session for a large blob. */
export async function createUploadSession(scope: Scope, path: string): Promise<UploadSessionState> {
  const res = await graphFetch(`${itemByPathUrl(scopeRef(scope), path)}:/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    }),
  }, scopeTier(scope));
  const data = await res.json();
  return { uploadUrl: data.uploadUrl };
}

/**
 * Drive an upload session to completion, resuming from wherever the session
 * says it left off. The upload URL is pre-authenticated — no auth header.
 * Returns the created driveItem id.
 */
export async function uploadToSession(
  uploadUrl: string,
  blob: Blob,
  onProgress?: (fraction: number) => void,
): Promise<UploadedItem> {
  // Ask the session where to resume (fresh sessions expect range 0-)
  let nextStart = 0;
  const statusRes = await storageFetch(uploadUrl);
  if (statusRes.ok) {
    const status = await statusRes.json();
    const ranges: string[] = status.nextExpectedRanges || ['0-'];
    nextStart = parseInt(ranges[0].split('-')[0], 10) || 0;
  } else if (statusRes.status === 404) {
    throw new GraphHttpError(404, uploadUrl, 'Upload session expired');
  }

  while (nextStart < blob.size) {
    const end = Math.min(nextStart + CHUNK_SIZE, blob.size);
    const chunk = blob.slice(nextStart, end);
    const res = await storageFetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes ${nextStart}-${end - 1}/${blob.size}`,
      },
      body: chunk,
    });
    if (!res.ok) {
      throw new GraphHttpError(res.status, uploadUrl, 'Chunk upload failed');
    }
    onProgress?.(end / blob.size);
    if (res.status === 201 || res.status === 200) {
      // Final chunk — response is the driveItem
      const item = await res.json();
      return { itemId: item.id };
    }
    const data = await res.json();
    const ranges: string[] = data.nextExpectedRanges || [];
    nextStart = ranges.length ? parseInt(ranges[0].split('-')[0], 10) : end;
  }
  throw new Error('Upload session ended without a driveItem');
}

/**
 * Upload a drop's file payload. Small files go up in one PUT; larger ones
 * use a resumable session. `existingSession` lets a reloaded tab resume.
 */
export async function uploadDropFile(
  scope: Scope,
  meta: DropMeta,
  blob: Blob,
  opts: {
    existingSessionUrl?: string;
    onSessionCreated?: (uploadUrl: string) => void;
    onProgress?: (fraction: number) => void;
  } = {},
): Promise<UploadedItem> {
  if (!meta.file) throw new Error('Not a file drop');
  if (blob.size <= SIMPLE_UPLOAD_LIMIT && !opts.existingSessionUrl) {
    return uploadSmallFile(scope, meta.file.path, blob);
  }
  let uploadUrl = opts.existingSessionUrl;
  if (uploadUrl) {
    try {
      return await uploadToSession(uploadUrl, blob, opts.onProgress);
    } catch (err) {
      if (!isGoneError(err)) throw err;
      console.debug('[Graph] Upload session expired — restarting');
    }
  }
  const session = await createUploadSession(scope, meta.file.path);
  uploadUrl = session.uploadUrl;
  opts.onSessionCreated?.(uploadUrl);
  return uploadToSession(uploadUrl, blob, opts.onProgress);
}

// ─── downloads & thumbnails ───

/** Blobs uploaded by any member live in the host's drive — address them there. */
function fileItemUrl(scope: Scope, itemId: string): string {
  return scope.kind === 'private'
    ? `${GRAPH_BASE}/me/drive/items/${itemId}`
    : `${GRAPH_BASE}/drives/${scope.driveId}/items/${itemId}`;
}

/**
 * Download a drop's file bytes. Untimed by default — a user waiting on a big
 * file should get it however long it takes. A caller fetching one as a
 * preview passes a limit, so a transfer left hanging can't hold a preview
 * slot for the rest of the session.
 */
export function downloadDropFile(scope: Scope, itemId: string, opts: { timeoutMs?: number } = {}): Promise<Blob> {
  const init: GraphInit = opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : { noTimeout: true };
  // Straight into a Blob, inside the limit when there is one — not through
  // graphFetch's buffering, which would hold a large image in memory twice.
  return graphRequest(`${fileItemUrl(scope, itemId)}/content`, init, scopeTier(scope), res => res.blob());
}

/**
 * Fetch a Graph-generated thumbnail for an image drop. The returned URL is
 * pre-authenticated and short-lived, so we fetch the bytes immediately and
 * the caller stores them in IndexedDB keyed by drop id.
 */
export async function fetchThumbnail(scope: Scope, itemId: string): Promise<Blob | null> {
  try {
    const res = await graphFetch(
      `${fileItemUrl(scope, itemId)}/thumbnails/0/large`,
      undefined,
      scopeTier(scope),
    );
    const data = await res.json();
    if (!data.url) return null;
    return await storageRead(data.url, deadline(undefined, THUMBNAIL_TIMEOUT_MS), async imgRes => {
      // Throttled is not "no thumbnail": reporting it as a miss would send
      // the caller off to download the full image, the opposite of backing off.
      if (imgRes.status === 429 || imgRes.status === 503) throw contentThrottleError(imgRes);
      if (!imgRes.ok) return null;
      return imgRes.blob();
    });
  } catch (err) {
    if (isGoneError(err)) return null;
    throw err;
  }
}

// ─── delta sync ───

export interface DeltaOptions {
  stats?: PassCounts;
  /**
   * Drop id → eTag this device already holds. An upsert at the same eTag is
   * not downloaded again — own sends, a resync after an expired token, and
   * whatever an interrupted earlier attempt already committed.
   */
  known?: ReadonlyMap<string, string | undefined>;
  /**
   * Receives downloaded drops in newest-first batches while the pass runs,
   * so the feed fills in as they arrive. Called one batch at a time; a batch
   * that fails fails the pass. Drops not yet handed over when the pass
   * completes come back in `upserts`, for the caller's final commit.
   */
  onBatch?: (records: DropRecord[]) => Promise<void>;
  /**
   * How many drops the pass is about to download. Called again, with one
   * fewer, each time a body turns out not to hold a drop: that one is never
   * handed over, and a caller counting "N of M" would wait for it for good.
   */
  onEnumerated?: (toDownload: number) => void;
  signal?: AbortSignal;
  /**
   * Ignore the saved token and enumerate everything: the restart after it
   * expired, or a caller that needs every drop checked against the server.
   */
  fromScratch?: boolean;
}

export interface DeltaResult {
  /** Downloaded drops not already handed to `onBatch`. */
  upserts: DropRecord[];
  removals: string[];
  /** True when the pass enumerated the whole feed (caller should reconcile). */
  fullResync: boolean;
  /** Every drop id the pass found present: downloaded, or held at the same eTag. */
  seenIds: Set<string>;
  /**
   * The token for the next pass. Returned, not saved: the caller commits it
   * in the same transaction as the drops it covers, so a token can never get
   * ahead of the data on this device.
   */
  deltaLink?: string;
}

interface DeltaItem {
  id: string;
  name?: string;
  deleted?: object;
  file?: object;
  eTag?: string;
  '@microsoft.graph.downloadUrl'?: string;
}

/** What the enumeration says should happen to one drop — its last word wins. */
type DeltaOp =
  | { kind: 'upsert'; itemId: string; eTag?: string; downloadUrl?: string }
  | { kind: 'delete' };

/** Bodies in flight per pass (the global body limiter also applies). */
const DELTA_CONCURRENCY = 6;
/** The first hand-over is small, so the screen fills quickly; later ones batch up. */
const FIRST_BATCH = 10;
const BATCH = 25;
/** How long finished drops wait for an in-order batch before going out as they are. */
const HAND_OVER_PATIENCE_MS = 1_000;

function deltaStartUrl(scope: Scope): string {
  return scope.kind === 'private'
    ? `${GRAPH_BASE}/me/drive/special/approot:/${DROPS_FOLDER}:/delta`
    : `${GRAPH_BASE}/drives/${scope.driveId}/items/${scope.dropsItemId}/delta`;
}

/**
 * True when a fresh delta start is rejected as unsupported (the unverified
 * cross-drive-shared-folder combination) — callers fall back to a children
 * listing. Distinct from 404/410 (folder gone) and 403 (access revoked —
 * e.g. the host removed this member), which must surface as access loss,
 * not trigger a fallback that would fail the same way forever.
 */
export function isDeltaUnsupportedError(err: unknown): boolean {
  return err instanceof GraphHttpError && (err.status === 400 || err.status === 501);
}

/** Gone OR forbidden — for a chat, both mean this account lost access. */
export function isAccessLostError(err: unknown): boolean {
  return isGoneError(err) || (err instanceof GraphHttpError && err.status === 403);
}

/**
 * Run a delta pass over a scope's drops folder, in two phases:
 *
 * 1. Enumerate every page. Pages are small and few; walking them all first
 *    means the whole change set is known before any body is fetched.
 * 2. Download the bodies this device doesn't already hold, several at once
 *    and newest first — drop ids are ULIDs, so the bottom of the feed (what
 *    the user is looking at) fills in first — handing them to `onBatch` in
 *    that same order as they complete.
 *
 * The next delta token comes back only when every body downloaded, so a
 * failure replays the changes next time instead of losing them. Batches
 * already handed over stay committed, and the eTag skip means the retry
 * fetches only what is still missing.
 *
 * A missing folder is an empty private feed, but for a chat it means access
 * was revoked or the chat deleted — that propagates to the caller.
 */
export async function runDelta(scope: Scope, opts: DeltaOptions = {}): Promise<DeltaResult> {
  const { stats, known, signal } = opts;
  const tier = scopeTier(scope);
  const isChat = scope.kind === 'chat';
  const savedToken = opts.fromScratch ? undefined : await getSetting<string>(deltaTokenKey(scope));
  const fullResync = !savedToken;

  // ── 1. enumerate ──
  // The same item can appear more than once across pages; the last
  // occurrence is its current state.
  const ops = new Map<string, DeltaOp>();
  let url = savedToken ?? deltaStartUrl(scope);
  let deltaLink: string | undefined;

  while (url) {
    let data: { value: DeltaItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
    try {
      const res = await graphFetch(url, { signal, timeoutMs: PAGE_TIMEOUT_MS }, tier);
      data = await res.json();
      if (stats) stats.pages++;
    } catch (err) {
      if (isGoneError(err)) {
        if (savedToken) {
          // Token expired — restart as a full delta. The stale token stays
          // stored until the caller commits the new one (or drops it).
          console.debug('[Sync] Delta token expired — full resync');
          return runDelta(scope, { ...opts, fromScratch: true });
        }
        if (isChat) throw err; // revoked / deleted — the caller decides
        // Only the opening request can say the folder doesn't exist yet (an
        // empty feed, not an error). "Gone" on a later page is a broken
        // enumeration: reported as an empty feed it would sweep every drop
        // this device holds, so it fails the pass instead.
        if (url !== deltaStartUrl(scope)) throw err;
        return { upserts: [], removals: [], fullResync, seenIds: new Set() };
      }
      throw err;
    }

    for (const item of data.value) {
      const name = item.name || '';
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (item.deleted) {
        ops.set(id, { kind: 'delete' });
      } else if (item.file) {
        ops.set(id, {
          kind: 'upsert',
          itemId: item.id,
          eTag: item.eTag,
          downloadUrl: item['@microsoft.graph.downloadUrl'],
        });
      }
    }

    if (data['@odata.deltaLink']) {
      deltaLink = data['@odata.deltaLink'];
      url = '';
    } else {
      url = data['@odata.nextLink'] || '';
    }
  }
  if (stats) stats.enumerated += ops.size;

  const removals: string[] = [];
  const seenIds = new Set<string>();
  const pending: Array<{ id: string; itemId: string; eTag?: string; downloadUrl?: string }> = [];
  for (const [id, op] of ops) {
    if (op.kind === 'delete') {
      removals.push(id);
    } else if (op.eTag !== undefined && known?.get(id) === op.eTag) {
      seenIds.add(id);
      if (stats) stats.skipped++;
    } else {
      pending.push({ id, itemId: op.itemId, eTag: op.eTag, downloadUrl: op.downloadUrl });
    }
  }
  pending.sort((a, b) => (a.id < b.id ? 1 : -1));
  /** Drops still expected out of `pending`: its length, less the bodies found malformed. */
  let expected = pending.length;
  opts.onEnumerated?.(expected);

  // ── 2. download, newest first ──
  // One slot per `pending` place: undefined while its body is downloading,
  // the record once it has arrived, null once there is nothing (left) to
  // hand over — a body that failed validation, or a record already handed.
  //
  // Downloads finish in any order, but drops are handed over in `pending`
  // order, so the feed grows upward from the newest with no gaps to fill in
  // later. A body that is merely slower than its neighbours delays the
  // hand-over behind it, never the downloads. One that stays missing past
  // HAND_OVER_PATIENCE_MS stops being waited for: a timer hands over what
  // has arrived around it, and the straggler slots in when it lands.
  const slots = new Array<DropRecord | null | undefined>(pending.length);
  let cursor = 0; // first slot that still has something to hand over, or to wait for
  let handedOver = 0;
  let lastHandOverAt = performance.now();
  let patienceTimer: ReturnType<typeof setTimeout> | undefined;
  let handing: Promise<void> = Promise.resolve();
  const failure: { failed: boolean; error?: unknown; commitFailed: boolean } = { failed: false, commitFailed: false };
  const fail = (error: unknown) => {
    if (failure.failed) return;
    failure.failed = true;
    failure.error = error;
  };

  /**
   * Hand finished drops to the caller, one batch at a time. 'in-order'
   * takes the run up to the first body still downloading, once it is a
   * batch's worth; 'everything' takes whatever has arrived. After a batch
   * fails to commit, nothing more is handed over.
   */
  const handOver = (mode: 'in-order' | 'everything'): boolean => {
    if (!opts.onBatch) return false;
    const take: number[] = [];
    for (let i = cursor; i < slots.length; i++) {
      const slot = slots[i];
      if (slot === undefined) {
        if (mode === 'in-order') break;
      } else if (slot) {
        take.push(i);
      }
    }
    if (take.length === 0) return false;
    if (mode === 'in-order' && take.length < (handedOver === 0 ? FIRST_BATCH : BATCH)) return false;
    const batch = take.map(i => slots[i] as DropRecord);
    for (const i of take) slots[i] = null;
    while (cursor < slots.length && slots[cursor] === null) cursor++;
    handedOver += batch.length;
    lastHandOverAt = performance.now();
    clearTimeout(patienceTimer);
    patienceTimer = undefined;
    const onBatch = opts.onBatch;
    handing = handing
      .then(() => (failure.commitFailed ? undefined : onBatch(batch)))
      .catch(err => {
        failure.commitFailed = true;
        fail(err);
      });
    return true;
  };

  /**
   * Patience runs on a clock, not on the next download finishing: if the
   * only bodies still in flight are stuck, nothing else would come along to
   * release the drops that have already arrived.
   */
  const armPatience = () => {
    if (!opts.onBatch || patienceTimer !== undefined) return;
    const wait = Math.max(0, lastHandOverAt + HAND_OVER_PATIENCE_MS - performance.now());
    patienceTimer = setTimeout(() => {
      patienceTimer = undefined;
      handOver('everything');
    }, wait);
  };

  try {
    await mapLimited(
      pending,
      DELTA_CONCURRENCY,
      async (op, index) => {
        // A batch that failed to commit fails the pass — stop fetching.
        if (failure.commitFailed) throw failure.error;
        const fallbackUrl = scope.kind === 'private'
          ? `${GRAPH_BASE}/me/drive/items/${op.itemId}/content`
          : `${GRAPH_BASE}/drives/${scope.driveId}/items/${op.itemId}/content`;
        const parsed = await downloadItemJson(
          { id: op.itemId, '@microsoft.graph.downloadUrl': op.downloadUrl },
          fallbackUrl,
          tier,
          { signal, stats },
        );
        if (stats) stats.downloaded++;
        // The file is there, whatever it holds. Seen, so that a full pass
        // does not sweep the copy already held as if the drop had been
        // deleted: only the unreadable replacement is passed over.
        seenIds.add(op.id);
        const meta = validateDropMeta(parsed, { expectedId: op.id, requireAuthor: isChat });
        if (meta) {
          slots[index] = { meta, eTag: op.eTag };
        } else {
          console.debug('[Sync] Discarding malformed drop JSON: %s.json', op.id);
          if (stats) stats.malformed++;
          slots[index] = null;
          opts.onEnumerated?.(--expected);
        }
        // In order while that keeps moving; around a straggler (or a slow
        // connection that hasn't filled a batch) once patience runs out.
        // Armed even after an in-order hand-over: drops that finished behind
        // a body still downloading are waiting on the clock too.
        handOver('in-order');
        armPatience();
      },
      signal,
    );
  } catch (err) {
    fail(err);
  } finally {
    // The pass is settling its own hand-overs from here: a timer firing
    // later would hand the final drops over a second time.
    clearTimeout(patienceTimer);
    patienceTimer = undefined;
  }

  if (failure.failed) {
    // Keep what did arrive: those drops are real server state, and the next
    // attempt skips them by eTag instead of fetching them again.
    handOver('everything');
    await handing;
    throw failure.error;
  }
  await handing;
  if (failure.failed) throw failure.error;
  const upserts = slots.filter((record): record is DropRecord => Boolean(record));
  return { upserts, removals, fullResync, seenIds, deltaLink };
}

export function clearDeltaToken(scope: Scope): Promise<void> {
  return deleteSetting(deltaTokenKey(scope));
}

/**
 * The settings that hold a scope's sync position: its delta token and change
 * markers. Deleting them makes its next pass enumerate everything, as a
 * fresh install would. For the private feed that includes the device
 * registry's marker, so device profiles re-list too.
 */
export function syncStateKeys(scope: Scope): string[] {
  return [deltaTokenKey(scope), folderCtagKey(scope), ...(scope.kind === 'private' ? [DEVICES_CTAG_KEY] : [])];
}

// ─── fast-path dirty check ───

/**
 * The cTag we watch per scope. Private watches the drops/ folder as before;
 * a chat watches the whole chat folder so member joins (members/ writes)
 * count as changes too.
 */
function dirtyCheckUrl(scope: Scope): string {
  return scope.kind === 'private'
    ? itemByPathUrl(APPROOT, DROPS_FOLDER)
    : `${GRAPH_BASE}/drives/${scope.driveId}/items/${scope.itemId}`;
}

/**
 * The scope's folder cTag right now — it changes whenever any descendant
 * changes. A sync pass reads it BEFORE its delta and commits that value with
 * the drops: anything that lands while the delta runs moves the cTag past
 * it, so the next poll syncs again rather than missing the change. Throws
 * like any Graph call (404 when the folder does not exist yet).
 */
export async function readFeedCTag(scope: Scope): Promise<string | undefined> {
  const res = await graphFetch(`${dirtyCheckUrl(scope)}?$select=cTag`, undefined, scopeTier(scope));
  const data = await res.json();
  return typeof data.cTag === 'string' && data.cTag ? data.cTag : undefined;
}

/**
 * One tiny GET that answers "did anything change?". Keeps the 45s poll
 * nearly free. Returns the cTag it read, so a pass it triggers can commit
 * that value without asking again.
 *
 * A gone folder is "nothing to sync" for private, but for chats it must
 * surface — revoked access is a state change the coordinator tracks.
 */
export async function isFeedDirty(scope: Scope): Promise<{ dirty: boolean; cTag?: string }> {
  try {
    const cTag = await readFeedCTag(scope);
    if (!cTag) return { dirty: true };
    const known = await getSetting<string>(folderCtagKey(scope));
    return { dirty: known !== cTag, cTag };
  } catch (err) {
    if (isGoneError(err)) {
      if (scope.kind === 'chat') throw err;
      return { dirty: false }; // folder not created yet — nothing to sync
    }
    throw err;
  }
}

export async function isDeviceRegistryDirty(): Promise<boolean> {
  try {
    const res = await graphFetch(`${itemByPathUrl(APPROOT, DEVICES_FOLDER)}?$select=cTag`);
    const data = await res.json();
    const cTag = data.cTag as string | undefined;
    if (!cTag) return true;
    const known = await getSetting<string>(DEVICES_CTAG_KEY);
    return known !== cTag;
  } catch (err) {
    if (isGoneError(err)) return false;
    throw err;
  }
}

export function markDeviceRegistryClean(cTag: string): Promise<void> {
  return putSetting(DEVICES_CTAG_KEY, cTag);
}
