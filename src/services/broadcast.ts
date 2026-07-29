/**
 * Cross-tab event propagation via BroadcastChannel.
 *
 * Uses BroadcastChannel API with a `storage` event fallback for older Safari
 * versions (<15.4) that don't support BroadcastChannel.
 *
 * Events:
 * - `sync-complete`: Drops were synced; other tabs should refresh from cache
 * - `drop-mutated`: A single drop was created/updated/deleted
 * - `auth-changed`: Auth state changed (sign-in/sign-out)
 */

export type BroadcastEvent =
  | { type: 'sync-complete' }
  | { type: 'drop-mutated'; dropId: string; action: 'upsert' | 'delete' }
  | { type: 'auth-changed'; signedIn: boolean };

type BroadcastHandler = (event: BroadcastEvent) => void;

const CHANNEL_NAME = 'milkbox-sync';
const STORAGE_KEY = 'milkbox:bc-msg';

let channel: BroadcastChannel | null = null;
const handlers: Set<BroadcastHandler> = new Set();
let storageHandlerAttached = false;

/** Initialise the broadcast channel. Safe to call multiple times. */
export function initBroadcast(): void {
  if (channel) return;

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e: MessageEvent) => {
      const data = e.data as BroadcastEvent;
      if (data?.type) {
        for (const handler of handlers) handler(data);
      }
    };
  } else if (!storageHandlerAttached) {
    // Fallback: use storage event (fires in other tabs when localStorage changes)
    window.addEventListener('storage', (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        const data = JSON.parse(e.newValue) as BroadcastEvent;
        if (data?.type) {
          for (const handler of handlers) handler(data);
        }
      } catch { /* ignore malformed */ }
    });
    storageHandlerAttached = true;
  }
}

/** Send an event to other tabs. */
export function postBroadcast(event: BroadcastEvent): void {
  if (channel) {
    channel.postMessage(event);
  } else {
    // Fallback: write to localStorage (triggers storage event in other tabs)
    try {
      // Append a timestamp to ensure the value always changes (storage event
      // only fires when the value actually differs from the previous one)
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...event, _ts: Date.now() }));
    } catch { /* localStorage may be unavailable */ }
  }
}

/** Subscribe to events from other tabs. Returns an unsubscribe function. */
export function onBroadcast(handler: BroadcastHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
