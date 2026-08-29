/**
 * Shared-chat Graph operations: chat folder CRUD in the host's approot,
 * invite links, share redemption, the member registry, roaming pointers,
 * and the listing fallback for drives where cross-drive delta is refused.
 *
 * Layout of one chat, in the HOST's OneDrive (Apps/Milkbox):
 *   chats/<chatUlid>/chat.json              — descriptor
 *   chats/<chatUlid>/drops/<ulid>.json      — the drops (delta/listing scope)
 *   chats/<chatUlid>/files/<ulid>/<name>    — binary payloads
 *   chats/<chatUlid>/members/<userId>.json  — one profile per member
 *
 * And in each MEMBER's own OneDrive (so joined chats roam across devices):
 *   chats-joined/<chatUlid>.json            — pointer into the host's drive
 */

import {
  GRAPH_BASE,
  GraphHttpError,
  contentUrl,
  graphFetch,
  isDeltaUnsupportedError,
  isGoneError,
  itemByPathUrl,
  runDelta,
  type DeltaResult,
  type DriveRef,
} from './graph';
import { validateChatDescriptor, validateChatMember, validateDropMeta, validateJoinedPointer } from './validate-drop';
import { ulid } from '../utils/ulid';
import type {
  AuthorAttribution,
  ChatDescriptor,
  ChatMember,
  ChatRecord,
  ChatScope,
  DropRecord,
  JoinedChatPointer,
} from '../types';

const APPROOT: DriveRef = { kind: 'approot' };
const CHATS_FOLDER = 'chats';
const JOINED_FOLDER = 'chats-joined';

const chatRef = (chat: { driveId: string; itemId: string }): DriveRef =>
  ({ kind: 'item', driveId: chat.driveId, itemId: chat.itemId });

// ─── identity ───

/** The signed-in person, for author attribution. Base tier — User.Read. */
export async function getMe(): Promise<AuthorAttribution> {
  const res = await graphFetch(`${GRAPH_BASE}/me?$select=id,displayName`);
  const data = await res.json();
  if (typeof data.id !== 'string' || !data.id) throw new Error('Graph /me returned no id');
  return { id: data.id, name: typeof data.displayName === 'string' && data.displayName ? data.displayName : 'Someone' };
}

// ─── generic small-JSON helpers ───

interface GraphChildItem {
  id: string;
  name?: string;
  file?: object;
  folder?: object;
  eTag?: string;
  parentReference?: { driveId?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

async function listChildren(
  ref: DriveRef,
  path: string,
  select: string,
  tier: 'base' | 'share',
): Promise<GraphChildItem[]> {
  let url = `${itemByPathUrl(ref, path)}:/children?$select=${select}`;
  const items: GraphChildItem[] = [];
  while (url) {
    const res = await graphFetch(url, undefined, tier);
    const data: { value: GraphChildItem[]; '@odata.nextLink'?: string } = await res.json();
    items.push(...data.value);
    url = data['@odata.nextLink'] || '';
  }
  return items;
}

async function downloadJson(item: GraphChildItem, driveId: string | undefined, tier: 'base' | 'share'): Promise<unknown> {
  const fallback = driveId
    ? `${GRAPH_BASE}/drives/${driveId}/items/${item.id}/content`
    : `${GRAPH_BASE}/me/drive/items/${item.id}/content`;
  const url = item['@microsoft.graph.downloadUrl'] || fallback;
  const res = item['@microsoft.graph.downloadUrl'] ? await fetch(url) : await graphFetch(url, undefined, tier);
  if (!res.ok) throw new GraphHttpError(res.status, url, 'JSON download failed');
  return res.json();
}

async function putJson(ref: DriveRef, path: string, body: unknown, tier: 'base' | 'share'): Promise<void> {
  await graphFetch(contentUrl(ref, path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body, null, 2),
  }, tier);
}

// ─── chat creation (host) ───

/**
 * Create the chat folder tree in the host's own approot and return the
 * registry record. Approot writes ride the base tier; the share tier is only
 * needed later, for the invite link.
 */
export async function createChatFolder(name: string, me: AuthorAttribution): Promise<ChatRecord> {
  const chatId = ulid();
  const createdAt = Date.now();
  const descriptor: ChatDescriptor = { v: 1, id: chatId, name, createdAt, host: me };

  // Path-based PUT auto-creates chats/<id>/ (and the approot itself).
  await putJson(APPROOT, `${CHATS_FOLDER}/${chatId}/chat.json`, descriptor, 'base');

  // drops/ must exist up front — it is the delta target.
  for (const folder of ['drops', 'members', 'files']) {
    await graphFetch(`${itemByPathUrl(APPROOT, `${CHATS_FOLDER}/${chatId}`)}:/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folder, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    }).catch(err => {
      // 409 nameAlreadyExists is fine (retry after a partial create)
      if (!(err instanceof GraphHttpError && err.status === 409)) throw err;
    });
  }

  const folderRes = await graphFetch(
    `${itemByPathUrl(APPROOT, `${CHATS_FOLDER}/${chatId}`)}?$select=id,parentReference`,
  );
  const folderItem = await folderRes.json();
  const dropsRes = await graphFetch(
    `${itemByPathUrl(APPROOT, `${CHATS_FOLDER}/${chatId}/drops`)}?$select=id`,
  );
  const dropsItem = await dropsRes.json();
  const driveId = folderItem.parentReference?.driveId as string | undefined;
  if (!driveId || !folderItem.id || !dropsItem.id) throw new Error('Chat folder creation incomplete');

  const record: ChatRecord = {
    id: chatId,
    name,
    role: 'host',
    driveId,
    itemId: folderItem.id as string,
    dropsItemId: dropsItem.id as string,
    host: me,
    joinedAt: createdAt,
    state: 'active',
  };

  await putMemberSelf(record, { v: 1, id: me.id, name: me.name, joinedAt: createdAt, updatedAt: createdAt });
  return record;
}

/** Host: delete the whole chat folder — ends the chat for everyone. */
export async function deleteChatFolder(chatId: string): Promise<void> {
  try {
    await graphFetch(itemByPathUrl(APPROOT, `${CHATS_FOLDER}/${chatId}`), { method: 'DELETE' });
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

// ─── invite links ───

export interface InviteLink {
  permissionId: string;
  webUrl: string;
}

/** Host: mint an edit sharing link on the chat folder (share tier). */
export async function createInviteLink(chat: { driveId: string; itemId: string }): Promise<InviteLink> {
  const res = await graphFetch(`${GRAPH_BASE}/drives/${chat.driveId}/items/${chat.itemId}/createLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'edit' }),
  }, 'share');
  const data = await res.json();
  const webUrl = data.link?.webUrl as string | undefined;
  const permissionId = data.id as string | undefined;
  if (!webUrl || !permissionId) throw new Error('createLink returned no link');
  return { permissionId, webUrl };
}

/** 'u!' + unpadded base64url — the /shares/{id} sharing-token encoding. */
export function encodeShareUrl(url: string): string {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(url)));
  return 'u!' + base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

/** Strict inverse of encodeShareUrl — returns null on any malformed input. */
export function decodeShareToken(token: string): string | null {
  if (!/^u![A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const base64 = token.slice(2).replace(/_/g, '/').replace(/-/g, '+');
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = new TextDecoder().decode(bytes);
    return /^https:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

// ─── joining (guest) ───

export interface SharedChatResolution {
  driveId: string;
  itemId: string;
  dropsItemId: string;
  descriptor: ChatDescriptor;
}

/**
 * Redeem a sharing token (durable access grant) and resolve the chat behind
 * it. Throws GraphHttpError for dead/rotated links; returns null when the
 * folder is reachable but is not a Milkbox chat.
 */
export async function resolveSharedChat(shareToken: string): Promise<SharedChatResolution | null> {
  const res = await graphFetch(`${GRAPH_BASE}/shares/${shareToken}/driveItem?$select=id,name,parentReference`, {
    headers: { Prefer: 'redeemSharingLink' },
  }, 'share');
  const item = await res.json();
  const driveId = item.parentReference?.driveId as string | undefined;
  const itemId = item.id as string | undefined;
  if (!driveId || !itemId) return null;

  const ref = chatRef({ driveId, itemId });
  let descriptor: ChatDescriptor | null;
  try {
    const bodyRes = await graphFetch(contentUrl(ref, 'chat.json'), undefined, 'share');
    descriptor = validateChatDescriptor(await bodyRes.json());
  } catch (err) {
    if (isGoneError(err)) return null; // shared folder, but not a chat
    throw err;
  }
  if (!descriptor) return null;

  const dropsRes = await graphFetch(`${itemByPathUrl(ref, 'drops')}?$select=id`, undefined, 'share');
  const dropsItem = await dropsRes.json();
  if (!dropsItem.id) return null;

  return { driveId, itemId, dropsItemId: dropsItem.id as string, descriptor };
}

// ─── member registry ───

export async function putMemberSelf(
  chat: { driveId: string; itemId: string; role?: 'host' | 'guest' },
  member: ChatMember,
): Promise<void> {
  await putJson(chatRef(chat), `members/${member.id}.json`, member, 'share');
}

export async function deleteMemberFile(chat: { driveId: string; itemId: string }, memberId: string): Promise<void> {
  try {
    await graphFetch(itemByPathUrl(chatRef(chat), `members/${memberId}.json`), { method: 'DELETE' }, 'share');
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

export async function listMembers(chat: { driveId: string; itemId: string }): Promise<ChatMember[]> {
  let items: GraphChildItem[];
  try {
    items = await listChildren(chatRef(chat), 'members', 'id,name,file,@microsoft.graph.downloadUrl', 'share');
  } catch (err) {
    if (isGoneError(err)) return [];
    throw err;
  }
  const members: ChatMember[] = [];
  for (const item of items) {
    if (!item.file || !item.name?.endsWith('.json')) continue;
    try {
      const member = validateChatMember(await downloadJson(item, chat.driveId, 'share'));
      if (member) members.push(member);
    } catch {
      // One unreadable member file must not hide the roster
    }
  }
  return members.sort((a, b) => a.joinedAt - b.joinedAt);
}

// ─── permissions (host moderation) ───

export interface ChatPermission {
  id: string;
  isLink: boolean;
  roles: string[];
  /** Display names of individual grantees (link grantees included, when exposed). */
  granteeNames: string[];
  granteeIds: string[];
}

export async function listChatPermissions(chat: { driveId: string; itemId: string }): Promise<ChatPermission[]> {
  const res = await graphFetch(`${GRAPH_BASE}/drives/${chat.driveId}/items/${chat.itemId}/permissions`, undefined, 'share');
  const data: { value: Array<Record<string, unknown>> } = await res.json();
  return (data.value || []).map(raw => {
    const identities: Array<{ user?: { id?: string; displayName?: string } }> = [];
    const v2 = raw.grantedToIdentitiesV2;
    if (Array.isArray(v2)) identities.push(...(v2 as typeof identities));
    const single = raw.grantedToV2 as { user?: { id?: string; displayName?: string } } | undefined;
    if (single) identities.push(single);
    return {
      id: String(raw.id ?? ''),
      isLink: raw.link !== undefined && raw.link !== null,
      roles: Array.isArray(raw.roles) ? (raw.roles as string[]) : [],
      granteeNames: identities.map(i => i.user?.displayName || '').filter(Boolean),
      granteeIds: identities.map(i => i.user?.id || '').filter(Boolean),
    };
  }).filter(p => p.id);
}

export async function deleteChatPermission(chat: { driveId: string; itemId: string }, permissionId: string): Promise<void> {
  try {
    await graphFetch(`${GRAPH_BASE}/drives/${chat.driveId}/items/${chat.itemId}/permissions/${permissionId}`, {
      method: 'DELETE',
    }, 'share');
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

// ─── roaming pointers (member's own approot) ───

export async function putJoinedPointer(pointer: JoinedChatPointer): Promise<void> {
  await putJson(APPROOT, `${JOINED_FOLDER}/${pointer.chatId}.json`, pointer, 'base');
}

export async function deleteJoinedPointer(chatId: string): Promise<void> {
  try {
    await graphFetch(itemByPathUrl(APPROOT, `${JOINED_FOLDER}/${chatId}.json`), { method: 'DELETE' });
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

export async function listJoinedPointers(): Promise<JoinedChatPointer[]> {
  let items: GraphChildItem[];
  try {
    items = await listChildren(APPROOT, JOINED_FOLDER, 'id,name,file,@microsoft.graph.downloadUrl', 'base');
  } catch (err) {
    if (isGoneError(err)) return [];
    throw err;
  }
  const pointers: JoinedChatPointer[] = [];
  for (const item of items) {
    if (!item.file || !item.name?.endsWith('.json')) continue;
    try {
      const pointer = validateJoinedPointer(await downloadJson(item, undefined, 'base'));
      if (pointer) pointers.push(pointer);
    } catch { /* skip unreadable pointer */ }
  }
  return pointers;
}

/**
 * Rediscover chats this account hosts by listing approot:/chats — used to
 * rebuild the registry on a fresh device (local IDB knows nothing yet).
 */
export async function listHostChats(me: AuthorAttribution): Promise<ChatRecord[]> {
  let items: GraphChildItem[];
  try {
    items = await listChildren(APPROOT, CHATS_FOLDER, 'id,name,folder,parentReference', 'base');
  } catch (err) {
    if (isGoneError(err)) return [];
    throw err;
  }
  const records: ChatRecord[] = [];
  for (const item of items) {
    if (!item.folder || !item.name) continue;
    try {
      const descRes = await graphFetch(contentUrl(APPROOT, `${CHATS_FOLDER}/${item.name}/chat.json`));
      const descriptor = validateChatDescriptor(await descRes.json());
      if (!descriptor || descriptor.id !== item.name) continue;
      const dropsRes = await graphFetch(`${itemByPathUrl(APPROOT, `${CHATS_FOLDER}/${item.name}/drops`)}?$select=id`);
      const dropsItem = await dropsRes.json();
      const driveId = item.parentReference?.driveId;
      if (!driveId || !dropsItem.id) continue;
      records.push({
        id: descriptor.id,
        name: descriptor.name,
        role: 'host',
        driveId,
        itemId: item.id,
        dropsItemId: dropsItem.id as string,
        host: me,
        joinedAt: descriptor.createdAt,
        state: 'active',
      });
    } catch { /* skip a chat folder we can't read */ }
  }
  return records;
}

// ─── sync: delta with listing fallback ───

/**
 * Full reconcile of a chat's drops via a plain children listing — the
 * fallback when cross-drive delta is refused. Downloads bodies only for new
 * ids or changed eTags; everything known locally but absent remotely is a
 * removal. Chats are small (a page or two), so this stays cheap.
 */
export async function listChatDrops(
  scope: ChatScope,
  known: Map<string, string | undefined>,
): Promise<DeltaResult> {
  let url = `${GRAPH_BASE}/drives/${scope.driveId}/items/${scope.dropsItemId}/children?$select=id,name,file,eTag,@microsoft.graph.downloadUrl`;
  const upserts: DropRecord[] = [];
  const seen = new Set<string>();

  while (url) {
    const res = await graphFetch(url, undefined, 'share');
    const data: { value: GraphChildItem[]; '@odata.nextLink'?: string } = await res.json();
    for (const item of data.value) {
      const name = item.name || '';
      if (!item.file || !name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      seen.add(id);
      if (known.has(id) && known.get(id) === item.eTag) continue;
      const parsed = await downloadJson(item, scope.driveId, 'share');
      const meta = validateDropMeta(parsed, { expectedId: id, requireAuthor: true });
      if (!meta) {
        console.debug('[Sync] Discarding malformed drop JSON: %s', name);
        continue;
      }
      upserts.push({ meta, eTag: item.eTag });
    }
    url = data['@odata.nextLink'] || '';
  }

  const removals = [...known.keys()].filter(id => !seen.has(id));
  return { upserts, removals, fullResync: true };
}

/**
 * One chat sync pass: delta when the drive supports it, silently learning
 * the listing fallback when it doesn't. Returns the strategy that worked so
 * the caller can persist it on the chat record.
 */
export async function runChatSync(
  scope: ChatScope,
  strategy: 'delta' | 'listing' | undefined,
  known: Map<string, string | undefined>,
): Promise<{ result: DeltaResult; strategy: 'delta' | 'listing' }> {
  if (strategy !== 'listing') {
    try {
      return { result: await runDelta(scope), strategy: 'delta' };
    } catch (err) {
      if (!isDeltaUnsupportedError(err)) throw err;
      console.debug('[Sync] Delta unsupported for chat %s — falling back to children listing', scope.chatId);
    }
  }
  return { result: await listChatDrops(scope, known), strategy: 'listing' };
}
