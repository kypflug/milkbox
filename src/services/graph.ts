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

import { getAccessToken } from './auth';
import { getSetting, putSetting, deleteSetting } from './db';
import { validateDropMeta } from './validate-drop';
import type { DeviceProfile, DropMeta, DropRecord } from '../types';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DROPS_FOLDER = 'drops';
const DEVICES_FOLDER = 'devices';
const DELTA_TOKEN_KEY = 'milkbox:delta-token';
const FOLDER_CTAG_KEY = 'milkbox:drops-ctag';
const DEVICES_CTAG_KEY = 'milkbox:devices-ctag';

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

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

async function graphFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = await authHeaders();
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

function contentUrl(path: string): string {
  return `${GRAPH_BASE}/me/drive/special/approot:/${path}:/content`;
}

function itemByPathUrl(path: string): string {
  return `${GRAPH_BASE}/me/drive/special/approot:/${path}`;
}

const dropJsonPath = (id: string) => `${DROPS_FOLDER}/${id}.json`;
const deviceJsonPath = (id: string) => `${DEVICES_FOLDER}/${id}.json`;

// ─── drop JSON CRUD ───

/**
 * Upload a drop's JSON. Path-based PUT auto-creates the drops/ folder (and
 * the approot itself) on first write. Pass eTag for a conditional write on
 * edits; on 412 the caller decides (we retry once unconditionally — the data
 * is single-user, conflicts are self-races, last write wins).
 */
export async function putDropJson(meta: DropMeta, eTag?: string): Promise<string | undefined> {
  const body = JSON.stringify(meta, null, 2);
  const doPut = (conditional: boolean) =>
    graphFetch(contentUrl(dropJsonPath(meta.id)), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(conditional && eTag ? { 'If-Match': eTag } : {}),
      },
      body,
    });

  try {
    const res = await doPut(true);
    const item = await res.json();
    return item.eTag as string | undefined;
  } catch (err) {
    if (err instanceof GraphHttpError && err.status === 412) {
      console.debug('[Graph] eTag conflict on %s — retrying last-write-wins', meta.id);
      const res = await doPut(false);
      const item = await res.json();
      return item.eTag as string | undefined;
    }
    throw err;
  }
}

/** Delete a drop's JSON. 404 = already gone = success. */
export async function deleteDropJson(id: string): Promise<void> {
  try {
    await graphFetch(itemByPathUrl(dropJsonPath(id)), { method: 'DELETE' });
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

/** Delete a drop's files/<id> folder (file/image drops). 404 = success. */
export async function deleteDropFiles(id: string): Promise<void> {
  try {
    await graphFetch(itemByPathUrl(`files/${id}`), { method: 'DELETE' });
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

// ─── device profiles ───

export async function putDeviceProfile(profile: DeviceProfile): Promise<void> {
  await graphFetch(contentUrl(deviceJsonPath(profile.id)), {
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
    const folderRes = await graphFetch(`${itemByPathUrl(DEVICES_FOLDER)}?$select=cTag`);
    const folder = await folderRes.json();
    cTag = folder.cTag as string | undefined;
  } catch (err) {
    if (isGoneError(err)) return { profiles: [] };
    throw err;
  }

  let url = `${itemByPathUrl(DEVICES_FOLDER)}:/children?$select=id,name,file,@microsoft.graph.downloadUrl`;
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
async function uploadSmallFile(path: string, blob: Blob): Promise<UploadedItem> {
  const res = await graphFetch(contentUrl(path), {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  const item = await res.json();
  return { itemId: item.id };
}

export interface UploadSessionState {
  uploadUrl: string;
}

/** Create a resumable upload session for a large blob. */
export async function createUploadSession(path: string): Promise<UploadSessionState> {
  const res = await graphFetch(`${itemByPathUrl(path)}:/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    }),
  });
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
    return uploadSmallFile(meta.file.path, blob);
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
  const session = await createUploadSession(meta.file.path);
  uploadUrl = session.uploadUrl;
  opts.onSessionCreated?.(uploadUrl);
  return uploadToSession(uploadUrl, blob, opts.onProgress);
}

// ─── downloads & thumbnails ───

/** Download a drop's file bytes. */
export async function downloadDropFile(itemId: string): Promise<Blob> {
  const res = await graphFetch(`${GRAPH_BASE}/me/drive/items/${itemId}/content`);
  return res.blob();
}

/**
 * Fetch a Graph-generated thumbnail for an image drop. The returned URL is
 * pre-authenticated and short-lived, so we fetch the bytes immediately and
 * the caller stores them in IndexedDB keyed by drop id.
 */
export async function fetchThumbnail(itemId: string): Promise<Blob | null> {
  try {
    const res = await graphFetch(
      `${GRAPH_BASE}/me/drive/items/${itemId}/thumbnails/0/large`,
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

/**
 * Run a delta pass over approot:/drops. Persists the delta token only after
 * every changed JSON body downloaded successfully, so a mid-pass failure
 * replays the page next time instead of losing changes.
 */
export async function runDelta(): Promise<DeltaResult> {
  const savedToken = await getSetting<string>(DELTA_TOKEN_KEY);
  let url = savedToken ?? `${GRAPH_BASE}/me/drive/special/approot:/${DROPS_FOLDER}:/delta`;
  const fullResync = !savedToken;

  const upserts: DropRecord[] = [];
  const removals: string[] = [];
  let finalDeltaLink: string | undefined;

  while (url) {
    let data: { value: DeltaItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
    try {
      const res = await graphFetch(url);
      data = await res.json();
    } catch (err) {
      if (isGoneError(err)) {
        if (savedToken) {
          // Token expired — clear it and restart as a full delta
          console.debug('[Sync] Delta token expired — full resync');
          await deleteSetting(DELTA_TOKEN_KEY);
          return runDelta();
        }
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
      const downloadUrl =
        item['@microsoft.graph.downloadUrl'] ||
        `${GRAPH_BASE}/me/drive/items/${item.id}/content`;
      const bodyRes = item['@microsoft.graph.downloadUrl']
        ? await fetch(downloadUrl)
        : await graphFetch(downloadUrl);
      if (!bodyRes.ok) throw new GraphHttpError(bodyRes.status, downloadUrl, 'Drop JSON download failed');
      const parsed: unknown = await bodyRes.json();
      const meta = validateDropMeta(parsed, { expectedId: name.slice(0, -5), requireAuthor: false });
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
    await putSetting(DELTA_TOKEN_KEY, finalDeltaLink);
  }

  return { upserts, removals, fullResync };
}

export function clearDeltaToken(): Promise<void> {
  return deleteSetting(DELTA_TOKEN_KEY);
}

// ─── fast-path dirty check ───

/**
 * One tiny GET that answers "did anything change?" — a folder's cTag changes
 * whenever any descendant changes. Keeps the 45s poll nearly free.
 * Returns true when a delta pass is warranted.
 */
export async function isFeedDirty(): Promise<boolean> {
  try {
    const res = await graphFetch(`${itemByPathUrl(DROPS_FOLDER)}?$select=cTag`);
    const data = await res.json();
    const cTag = data.cTag as string | undefined;
    if (!cTag) return true;
    const known = await getSetting<string>(FOLDER_CTAG_KEY);
    return known !== cTag;
  } catch (err) {
    if (isGoneError(err)) return false; // folder not created yet — nothing to sync
    throw err;
  }
}

/** Record the folder cTag after a completed sync pass. */
export async function markFeedClean(): Promise<void> {
  try {
    const res = await graphFetch(`${itemByPathUrl(DROPS_FOLDER)}?$select=cTag`);
    const data = await res.json();
    if (data.cTag) await putSetting(FOLDER_CTAG_KEY, data.cTag);
  } catch {
    // Folder may not exist yet — fine
  }
}

export async function isDeviceRegistryDirty(): Promise<boolean> {
  try {
    const res = await graphFetch(`${itemByPathUrl(DEVICES_FOLDER)}?$select=cTag`);
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
