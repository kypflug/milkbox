/**
 * Ingest validation for JSON fetched from OneDrive.
 *
 * Private-feed JSON is self-authored, but shared-chat JSON is written by
 * other members' clients — treat every parsed body as untrusted input.
 * Validators rebuild a clean object from known fields (never pass the raw
 * parse through) and return null on any violation; callers drop the record
 * with a console.debug rather than throwing, so a hostile file can't wedge
 * a sync pass.
 */

import type { AuthorAttribution, ChatDescriptor, ChatMember, DropKind, DropMeta, JoinedChatPointer } from '../types';

/** Crockford base32 ULID — first char caps the 48-bit timestamp. */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const KINDS: readonly DropKind[] = ['text', 'link', 'file', 'image'];

const MAX_TEXT = 65_536;
const MAX_URL = 2_048;
const MAX_NAME = 255;
const MAX_LABEL = 128;
const MAX_ID = 64;
const MAX_TITLE = 512;
const MAX_MIME = 128;

export function isValidUlid(id: unknown): id is string {
  return typeof id === 'string' && ULID_RE.test(id);
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function optStr(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  return str(value, max);
}

function finiteNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function author(value: unknown): AuthorAttribution | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const id = str(raw.id, MAX_ID);
  const name = str(raw.name, MAX_LABEL);
  if (!id || !name) return null;
  return { id, name };
}

/** Validate a chat.json body fetched from a (possibly foreign) drive. */
export function validateChatDescriptor(raw: unknown): ChatDescriptor | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.v !== 1 || !isValidUlid(body.id)) return null;
  const name = str(body.name, MAX_LABEL);
  const createdAt = finiteNum(body.createdAt);
  const host = author(body.host);
  if (!name || createdAt === null || !host) return null;
  return { v: 1, id: body.id, name, createdAt, host };
}

/** Validate a members/<id>.json body — written by other members' clients. */
export function validateChatMember(raw: unknown): ChatMember | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.v !== 1) return null;
  const id = str(body.id, MAX_ID);
  const name = str(body.name, MAX_LABEL);
  const joinedAt = finiteNum(body.joinedAt);
  const updatedAt = finiteNum(body.updatedAt);
  if (!id || !name || joinedAt === null || updatedAt === null) return null;
  return { v: 1, id, name, joinedAt, updatedAt };
}

/** Validate a chats-joined/<id>.json roaming pointer from our own approot. */
export function validateJoinedPointer(raw: unknown): JoinedChatPointer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (body.v !== 1 || !isValidUlid(body.chatId)) return null;
  const name = str(body.name, MAX_LABEL);
  const driveId = str(body.driveId, MAX_LABEL);
  const itemId = str(body.itemId, 256);
  const dropsItemId = str(body.dropsItemId, 256);
  const host = author(body.host);
  const joinedAt = finiteNum(body.joinedAt);
  if (!name || !driveId || !itemId || !dropsItemId || !host || joinedAt === null) return null;
  return { v: 1, chatId: body.chatId, name, driveId, itemId, dropsItemId, host, joinedAt };
}

export interface ValidateDropOptions {
  /** ULID derived from the filename — the body's id must match exactly. */
  expectedId: string;
  /** Chat drops must carry an author; an absent one would render as the host. */
  requireAuthor: boolean;
}

/**
 * Validate and rebuild a DropMeta parsed from a drops/<ulid>.json body.
 * Returns null when the record must be discarded.
 */
export function validateDropMeta(raw: unknown, opts: ValidateDropOptions): DropMeta | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;

  if (body.v !== 1) return null;
  if (!isValidUlid(body.id) || body.id !== opts.expectedId) return null;
  const kind = KINDS.find(k => k === body.kind);
  if (!kind) return null;
  const createdAt = finiteNum(body.createdAt);
  if (createdAt === null) return null;

  // Device attribution: id optional (pre-profile drops), name/os required.
  if (typeof body.device !== 'object' || body.device === null) return null;
  const rawDevice = body.device as Record<string, unknown>;
  const deviceName = str(rawDevice.name, MAX_LABEL);
  const deviceOs = typeof rawDevice.os === 'string' && rawDevice.os.length <= MAX_LABEL ? rawDevice.os : null;
  const deviceId = optStr(rawDevice.id, MAX_ID);
  if (!deviceName || deviceOs === null || deviceId === null) return null;

  const dropAuthor = body.author === undefined ? undefined : author(body.author);
  if (dropAuthor === null) return null;
  if (opts.requireAuthor && !dropAuthor) return null;

  const meta: DropMeta = {
    v: 1,
    id: body.id,
    kind,
    createdAt,
    device: { name: deviceName, os: deviceOs, ...(deviceId ? { id: deviceId } : {}) },
    ...(dropAuthor ? { author: dropAuthor } : {}),
  };

  const editedAt = body.editedAt === undefined ? undefined : finiteNum(body.editedAt);
  if (editedAt === null) return null;
  if (editedAt !== undefined) meta.editedAt = editedAt;

  const text = optStr(body.text, MAX_TEXT);
  if (text === null) return null;
  if (text !== undefined) meta.text = text;

  if (kind === 'link') {
    const url = str(body.url, MAX_URL);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    meta.url = url;
    if (body.link !== undefined) {
      if (typeof body.link !== 'object' || body.link === null) return null;
      const rawLink = body.link as Record<string, unknown>;
      const domain = str(rawLink.domain, MAX_NAME);
      const title = optStr(rawLink.title, MAX_TITLE);
      if (!domain || title === null) return null;
      meta.link = { domain, ...(title !== undefined ? { title } : {}) };
    }
  }

  if (kind === 'file' || kind === 'image') {
    if (typeof body.file !== 'object' || body.file === null) return null;
    const rawFile = body.file as Record<string, unknown>;
    const name = str(rawFile.name, MAX_NAME);
    const size = finiteNum(rawFile.size);
    const mime = typeof rawFile.mime === 'string' && rawFile.mime.length <= MAX_MIME ? rawFile.mime : null;
    const path = str(rawFile.path, MAX_URL);
    const itemId = optStr(rawFile.itemId, 256);
    const width = rawFile.width === undefined ? undefined : finiteNum(rawFile.width);
    const height = rawFile.height === undefined ? undefined : finiteNum(rawFile.height);
    if (!name || size === null || size < 0 || mime === null || !path || itemId === null || width === null || height === null) {
      return null;
    }
    // The payload must live inside this drop's own files/ folder — a remote
    // author must not be able to point a card at someone else's file.
    if (!path.startsWith(`files/${meta.id}/`) || path.includes('..') || path.includes(':')) return null;
    meta.file = {
      name,
      size,
      mime,
      path,
      ...(itemId !== undefined ? { itemId } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  }

  return meta;
}
