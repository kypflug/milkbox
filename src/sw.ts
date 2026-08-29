/**
 * Milkbox service worker (injectManifest).
 *
 * Precaches the app shell and handles the Web Share Target POST: the OS
 * share sheet POSTs multipart form data to /share-target; we park the
 * payload (including File objects — structured-cloneable) in the
 * milkbox-share IndexedDB and 303-redirect to the app shell, which the
 * precache serves even offline. The app drains the inbox on boot.
 *
 * Content bytes (thumbnails, files) are deliberately NOT cached here —
 * Graph download URLs are pre-authenticated and short-lived, so URL-keyed
 * HTTP caching would never hit. The app caches bytes in IndexedDB keyed
 * by drop id instead.
 *
 * There is no push handler: with no server there is nothing to send a push,
 * so backgrounded pages keep polling and ask us to raise the notification.
 */

/// <reference lib="WebWorker" />
declare const self: ServiceWorkerGlobalScope;

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

interface NotifyItem {
  id: string;
  title: string;
  body: string;
  /** Scope the drop landed in ('private' | 'chat:<ulid>'). Optional — items
   *  from an older tab won't carry it, and that's fine. */
  scopeId?: string;
}

type SwMessage =
  | { type: 'SKIP_WAITING' }
  | { type: 'MILKBOX_NOTIFY'; items: unknown };

/**
 * A tab left running on an older build can post a shape we no longer expect,
 * so nothing off the message port is trusted past this check.
 */
function isNotifyItem(value: unknown): value is NotifyItem {
  if (typeof value !== 'object' || value === null) return false;
  const { id, title, body, scopeId } = value as Record<string, unknown>;
  if (scopeId !== undefined && typeof scopeId !== 'string') return false;
  return typeof id === 'string' && typeof title === 'string' && typeof body === 'string';
}

self.addEventListener('message', event => {
  const data = event.data as SwMessage | undefined;
  if (!data?.type) return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'MILKBOX_NOTIFY' && Array.isArray(data.items)) {
    event.waitUntil(announce(data.items));
  }
});

// Never intercept authed API or login traffic
registerRoute(/^https:\/\/graph\.microsoft\.com\/.*/i, new NetworkOnly());
registerRoute(/^https:\/\/login\.microsoftonline\.com\/.*/i, new NetworkOnly());

// Favicons for link drops — small, immutable-ish, fine to cache by URL
registerRoute(
  /^https:\/\/icons\.duckduckgo\.com\/.*/i,
  new CacheFirst({
    cacheName: 'link-favicons',
    plugins: [
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);

// ─── notifications ───

/**
 * Announce drops the page found while it was backgrounded.
 *
 * The page can't make this call itself: every open tab polls, so every open
 * tab asks, and only the worker can see all of them at once. If any window
 * is focused the user is already looking at the feed and we stay quiet;
 * otherwise tagging by drop id collapses the duplicate asks into one
 * notification per drop.
 *
 * includeUncontrolled matters: we never claim(), so a tab loaded before this
 * worker activated is still same-origin and on screen but not controlled by
 * it, and would otherwise be invisible to the focus check.
 */
async function announce(items: readonly unknown[]): Promise<void> {
  const valid = items.filter(isNotifyItem);
  if (!valid.length) return;

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.some(client => client.visibilityState === 'visible' && client.focused)) return;

  for (const item of valid) {
    try {
      await self.registration.showNotification(item.title, {
        body: item.body,
        tag: `milkbox-drop-${item.id}`,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-48.png',
        data: { dropId: item.id, scopeId: item.scopeId },
      });
    } catch (err) {
      // Permission can be revoked while this worker is still alive. Announcing
      // is never load-bearing, so warn and keep going rather than rejecting
      // waitUntil and losing the rest of the batch.
      console.warn('[SW] Notification failed for %s:', item.id, err);
    }
  }
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const scopeId = (event.notification.data as { scopeId?: string } | undefined)?.scopeId;
  // Crockford base32 only — anything else falls back to the plain shell.
  const chatId = scopeId?.startsWith('chat:') ? scopeId.slice(5) : null;
  const target = chatId && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(chatId) ? `/#chat/${chatId}` : '/';
  event.waitUntil(
    (async () => {
      // Reuse an open window when there is one — matching the manifest's
      // navigate-existing launch handler rather than piling up windows.
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const existing = windows.find(
        client => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.focus();
        // The page routes by hash; tell it which scope the tap meant.
        existing.postMessage({ type: 'MILKBOX_OPEN_SCOPE', scopeId: scopeId ?? 'private' });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

// ─── share target ───

const SHARE_DB = 'milkbox-share';
const SHARE_STORE = 'inbox';

function openShareDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SHARE_STORE)) {
        req.result.createObjectStore(SHARE_STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function depositShare(formData: FormData): Promise<void> {
  const payload = {
    title: (formData.get('title') as string) || undefined,
    text: (formData.get('text') as string) || undefined,
    url: (formData.get('url') as string) || undefined,
    files: formData.getAll('files').filter((f): f is File => f instanceof File),
    receivedAt: Date.now(),
  };
  const db = await openShareDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(SHARE_STORE, 'readwrite');
    t.objectStore(SHARE_STORE).add(payload);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          await depositShare(formData);
        } catch (err) {
          console.warn('[SW] Share target deposit failed:', err);
        }
        // 303 converts the POST into a GET of the app shell — served from
        // the precache even offline.
        return Response.redirect('/?share=1', 303);
      })(),
    );
  }
});
