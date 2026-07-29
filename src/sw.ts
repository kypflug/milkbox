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
 */

/// <reference lib="WebWorker" />
declare const self: ServiceWorkerGlobalScope;

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
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
