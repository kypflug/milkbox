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
import { scopeIdOf, type DeviceProfile, type DropMeta, type DropRecord, type Scope } from '../types';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DROPS_FOLDER = 'drops';
const DEVICES_FOLDER = 'devices';
const DEVICES_CTAG_KEY = 'milkbox:devices-ctag';

const deltaTokenKey = (scope: Scope) => `milkbox:delta-token:${scopeIdOf(scope)}`;
const folderCtagKey = (scope: Scope) => `milkbox:ctag:${scopeIdOf(scope)}`;

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

export async function graphFetch(url: string, init?: RequestInit, tier: TokenTier = 'base'): Promise<Response> {
  const headers = await authHeaders(tier);
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const retryAfter = res.headers.get('Retry-After');
    throw new GraphHttpError(
      res.status,
      url,
      undefined,
      retryAfter ? parseInt(retryAfter, 10) : undefined,
    );
  }
  return res;
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
 * Upload a drop's JSON. Path-based PUT auto-creates the drops/ folder (and
 * the approot itself) on first write. Pass eTag for a conditional write on
 * edits. Conflict handling differs by scope:
 * - private: retry once unconditionally — the data is single-user, conflicts
 *   are self-races, last write wins;
 * - chat: strictly conditional — 412/404 becomes DropConflictError so a
 *   queued edit can never recreate a drop another member deleted.
 */
export async function putDropJson(scope: Scope, meta: DropMeta, eTag?: string): Promise<string | undefined> {
  const ref = scopeRef(scope);
  const tier = scopeTier(scope);
  const body = JSON.stringify(meta, null, 2);
  const doPut = (conditional: boolean) =>
    graphFetch(contentUrl(ref, dropJsonPath(meta.id)), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(conditional && eTag ? { 'If-Match': eTag } : {}),
      },
      body,
    }, tier);

  try {
    const res = await doPut(true);
    const item = await res.json();
    return item.eTag as string | undefined;
  } catch (err) {
    if (err instanceof GraphHttpError && (err.status === 412 || (eTag !== undefined && err.status === 404))) {
      if (scope.kind === 'chat') throw new DropConflictError(meta.id);
      console.debug('[Graph] eTag conflict on %s — retrying last-write-wins', meta.id);
      const res = await doPut(false);
      const item = await res.json();
      return item.eTag as string | undefined;
    }
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

export async function putDeviceProfile(profile: DeviceProfile): Promise<void> {
  await graphFetch(contentUrl(APPROOT, deviceJsonPath(profile.id)), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile, null, 2),
  });
}

interface GraphFileItem {
  id: string;
  name?: string;
  file?: object;
  '@microsoft.graph.downloadUrl'?: string;
}

export interface DeviceProfileSnapshot {
  profiles: DeviceProfile[];
  cTag?: string;
}

export async function listDeviceProfiles(): Promise<DeviceProfileSnapshot> {
  let cTag: string | undefined;
  try {
    const folderRes = await graphFetch(`${itemByPathUrl(APPROOT, DEVICES_FOLDER)}?$select=cTag`);
    const folder = await folderRes.json();
    cTag = folder.cTag as string | undefined;
  } catch (err) {
    if (isGoneError(err)) return { profiles: [] };
    throw err;
  }

  let url = `${itemByPathUrl(APPROOT, DEVICES_FOLDER)}:/children?$select=id,name,file,@microsoft.graph.downloadUrl`;
  const profiles: DeviceProfile[] = [];

  while (url) {
    let data: { value: GraphFileItem[]; '@odata.nextLink'?: string };
    try {
      const res = await graphFetch(url);
      data = await res.json();
    } catch (err) {
      if (isGoneError(err)) return { profiles: [], cTag };
      throw err;
    }

    for (const item of data.value) {
      if (!item.file || !item.name?.endsWith('.json')) continue;
      const downloadUrl =
        item['@microsoft.graph.downloadUrl'] ||
        `${GRAPH_BASE}/me/drive/items/${item.id}/content`;
      const bodyRes = item['@microsoft.graph.downloadUrl']
        ? await fetch(downloadUrl)
        : await graphFetch(downloadUrl);
      if (!bodyRes.ok) {
        throw new GraphHttpError(bodyRes.status, downloadUrl, 'Device profile download failed');
      }
      const profile = (await bodyRes.json()) as DeviceProfile;
      if (
        profile?.v === 1 &&
        profile.id &&
        profile.name &&
        Number.isFinite(profile.createdAt) &&
        Number.isFinite(profile.updatedAt)
      ) {
        profiles.push(profile);
      }
    }

    url = data['@odata.nextLink'] || '';
  }

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
  const statusRes = await fetch(uploadUrl);
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
    const res = await fetch(uploadUrl, {
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

/** Download a drop's file bytes. */
export async function downloadDropFile(scope: Scope, itemId: string): Promise<Blob> {
  const res = await graphFetch(`${fileItemUrl(scope, itemId)}/content`, undefined, scopeTier(scope));
  return res.blob();
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
    const imgRes = await fetch(data.url);
    if (!imgRes.ok) return null;
    return imgRes.blob();
  } catch (err) {
    if (isGoneError(err)) return null;
    throw err;
  }
}

// ─── delta sync ───

export interface DeltaResult {
  upserts: DropRecord[];
  removals: string[];
  /** True when the pass replaced the whole feed (caller should reconcile). */
  fullResync: boolean;
}

interface DeltaItem {
  id: string;
  name?: string;
  deleted?: object;
  file?: object;
  eTag?: string;
  '@microsoft.graph.downloadUrl'?: string;
}

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
 * Run a delta pass over a scope's drops folder. Persists the delta token only
 * after every changed JSON body downloaded successfully, so a mid-pass failure
 * replays the page next time instead of losing changes.
 *
 * A missing folder is an empty private feed, but for a chat it means access
 * was revoked or the chat deleted — that propagates to the caller.
 */
export async function runDelta(scope: Scope): Promise<DeltaResult> {
  const tokenKey = deltaTokenKey(scope);
  const tier = scopeTier(scope);
  const isChat = scope.kind === 'chat';
  const savedToken = await getSetting<string>(tokenKey);
  let url = savedToken ?? deltaStartUrl(scope);
  const fullResync = !savedToken;

  const upserts: DropRecord[] = [];
  const removals: string[] = [];
  let finalDeltaLink: string | undefined;

  while (url) {
    let data: { value: DeltaItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
    try {
      const res = await graphFetch(url, undefined, tier);
      data = await res.json();
    } catch (err) {
      if (isGoneError(err)) {
        if (savedToken) {
          // Token expired — clear it and restart as a full delta
          console.debug('[Sync] Delta token expired — full resync');
          await deleteSetting(tokenKey);
          return runDelta(scope);
        }
        if (isChat) throw err; // revoked / deleted — the caller decides
        // Folder doesn't exist yet — empty feed, not an error
        return { upserts: [], removals: [], fullResync };
      }
      throw err;
    }

    for (const item of data.value) {
      const name = item.name || '';
      if (item.deleted) {
        if (name.endsWith('.json')) removals.push(name.slice(0, -5));
        continue;
      }
      if (!item.file || !name.endsWith('.json')) continue;

      // Prefer the pre-authenticated downloadUrl from the delta response —
      // no extra token round-trip per item.
      const fallbackUrl = scope.kind === 'private'
        ? `${GRAPH_BASE}/me/drive/items/${item.id}/content`
        : `${GRAPH_BASE}/drives/${scope.driveId}/items/${item.id}/content`;
      const downloadUrl = item['@microsoft.graph.downloadUrl'] || fallbackUrl;
      const bodyRes = item['@microsoft.graph.downloadUrl']
        ? await fetch(downloadUrl)
        : await graphFetch(downloadUrl, undefined, tier);
      if (!bodyRes.ok) throw new GraphHttpError(bodyRes.status, downloadUrl, 'Drop JSON download failed');
      const parsed: unknown = await bodyRes.json();
      const meta = validateDropMeta(parsed, { expectedId: name.slice(0, -5), requireAuthor: isChat });
      if (!meta) {
        console.debug('[Sync] Discarding malformed drop JSON: %s', name);
        continue;
      }
      upserts.push({ meta, eTag: item.eTag });
    }

    if (data['@odata.deltaLink']) {
      finalDeltaLink = data['@odata.deltaLink'];
      url = '';
    } else {
      url = data['@odata.nextLink'] || '';
    }
  }

  if (finalDeltaLink) {
    await putSetting(tokenKey, finalDeltaLink);
  }

  return { upserts, removals, fullResync };
}

export function clearDeltaToken(scope: Scope): Promise<void> {
  return deleteSetting(deltaTokenKey(scope));
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
 * One tiny GET that answers "did anything change?" — a folder's cTag changes
 * whenever any descendant changes. Keeps the 45s poll nearly free.
 * Returns true when a delta pass is warranted.
 *
 * A gone folder is "nothing to sync" for private, but for chats it must
 * surface — revoked access is a state change the coordinator tracks.
 */
export async function isFeedDirty(scope: Scope): Promise<boolean> {
  try {
    const res = await graphFetch(`${dirtyCheckUrl(scope)}?$select=cTag`, undefined, scopeTier(scope));
    const data = await res.json();
    const cTag = data.cTag as string | undefined;
    if (!cTag) return true;
    const known = await getSetting<string>(folderCtagKey(scope));
    return known !== cTag;
  } catch (err) {
    if (isGoneError(err)) {
      if (scope.kind === 'chat') throw err;
      return false; // folder not created yet — nothing to sync
    }
    throw err;
  }
}

/** Record the folder cTag after a completed sync pass. */
export async function markFeedClean(scope: Scope): Promise<void> {
  try {
    const res = await graphFetch(`${dirtyCheckUrl(scope)}?$select=cTag`, undefined, scopeTier(scope));
    const data = await res.json();
    if (data.cTag) await putSetting(folderCtagKey(scope), data.cTag);
  } catch {
    // Folder may not exist yet — fine
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
