export type Theme = 'light' | 'dark' | 'system';

export type DropKind = 'text' | 'link' | 'file' | 'image';

export interface DeviceAttribution {
  /** Stable installation ID. Absent on drops created before device profiles. */
  id?: string;
  name: string;
  os: string;
}

/** Person identity (Graph user id + display name), distinct from the device. */
export interface AuthorAttribution {
  id: string;
  name: string;
}

export interface DeviceProfile {
  v: 1;
  id: string;
  name: string;
  os: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One drop in the feed. Stored as `drops/<id>.json` in the OneDrive approot;
 * `id` is a ULID so lexical order is chronological order.
 */
export interface DropMeta {
  v: 1;
  id: string;
  kind: DropKind;
  createdAt: number;
  editedAt?: number;
  /** Which device sent it — shown in the metadata line. */
  device: DeviceAttribution;
  /**
   * Who wrote it (Graph user). Stamped on all new drops; absent on
   * pre-multiplayer drops. Chat scopes require it at ingest — the private
   * feed treats an absent author as "me".
   */
  author?: AuthorAttribution;
  /** Body text (text drops) or optional caption (file/image drops). */
  text?: string;
  /** Link drops. */
  url?: string;
  link?: { title?: string; domain: string };
  /** File/image drops. Blob lives at `files/<id>/<name>` in the approot. */
  file?: {
    name: string;
    size: number;
    mime: string;
    path: string;
    /** Graph driveItem id, filled after upload (thumbnails, delete). */
    itemId?: string;
    width?: number;
    height?: number;
  };
}

/** Locally-known sync state for a drop; never uploaded. */
export interface DropRecord {
  meta: DropMeta;
  /** Graph eTag of the JSON item, for conditional writes. */
  eTag?: string;
  /** Pending outbox state overlays: 'sending' | 'failed'. Absent = synced. */
  state?: 'sending' | 'failed';
}

/** A queued outgoing drop, persisted so uploads survive reloads. */
export interface OutboxRecord {
  id: string;
  meta: DropMeta;
  /** File payload for file/image drops. */
  blob?: Blob;
  /** Resumable Graph upload session URL, once created. */
  uploadUrl?: string;
  op: 'create' | 'edit' | 'delete';
  attempts: number;
  state: 'queued' | 'sending' | 'failed';
  /**
   * Destination scope. Optional so pre-v3 records parse; the v3 migration
   * stamps 'private' and the coordinator treats absence as 'private'.
   */
  scopeId?: ScopeId;
}

// ─── Shared chats ───

/** 'private' or `chat:<chatUlid>` — the key that namespaces per-scope state. */
export type ScopeId = string;

export interface PrivateScope {
  kind: 'private';
}

/** A shared chat — a folder in the HOST's OneDrive. */
export interface ChatScope {
  kind: 'chat';
  chatId: string;
  name: string;
  role: 'host' | 'guest';
  /** The host's drive. */
  driveId: string;
  /** driveItem id of the chat folder in the host's drive. */
  itemId: string;
  /** driveItem id of the drops/ subfolder — the delta target. */
  dropsItemId: string;
  host: AuthorAttribution;
}

export type Scope = PrivateScope | ChatScope;

export function scopeIdOf(scope: Scope): ScopeId {
  return scope.kind === 'private' ? 'private' : `chat:${scope.chatId}`;
}

/** Local chat registry record — IDB `chats` store, keyed by chat ULID. */
export interface ChatRecord {
  id: string;
  name: string;
  role: 'host' | 'guest';
  driveId: string;
  itemId: string;
  dropsItemId: string;
  host: AuthorAttribution;
  joinedAt: number;
  /** Last drop the user has seen — a scroll/read anchor, not the unread source. */
  lastReadDropId?: string;
  /** Maintained from sync arrival sets (ULID order is clock-skew unsafe). */
  unreadCount?: number;
  /** Learned per chat: delta by default, auto-falls back to children listing. */
  syncStrategy?: 'delta' | 'listing';
  /** 'gone' = folder persistently 404s (revoked/deleted); 'needs-consent' = share token lost. */
  state?: 'active' | 'gone' | 'needs-consent';
  /** Host only: the last created invite link, for re-showing the QR. */
  shareUrl?: string;
}

/** OneDrive-side descriptor: chats/<id>/chat.json in the host's approot. */
export interface ChatDescriptor {
  v: 1;
  id: string;
  name: string;
  createdAt: number;
  host: AuthorAttribution;
}

/** OneDrive-side member registry: chats/<id>/members/<graphUserId>.json */
export interface ChatMember {
  v: 1;
  id: string;
  name: string;
  joinedAt: number;
  updatedAt: number;
}

/**
 * Roaming pointer written to the MEMBER's own approot at chats-joined/<chatId>.json
 * so joined chats follow the account to its other devices.
 */
export interface JoinedChatPointer {
  v: 1;
  chatId: string;
  name: string;
  driveId: string;
  itemId: string;
  dropsItemId: string;
  host: AuthorAttribution;
  joinedAt: number;
}

/** Payload deposited by the service worker for a share-target invocation. */
export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
  files: File[];
  receivedAt: number;
}
