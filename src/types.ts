export type Theme = 'light' | 'dark' | 'system';

export type DropKind = 'text' | 'link' | 'file' | 'image';

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
  device: { name: string; os: string };
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
}

/** Payload deposited by the service worker for a share-target invocation. */
export interface SharePayload {
  title?: string;
  text?: string;
  url?: string;
  files: File[];
  receivedAt: number;
}
