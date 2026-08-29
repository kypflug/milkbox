/**
 * Local notifications for drops that land while Milkbox is in the background.
 *
 * Deliberately not Web Push. Sending a push needs an application server
 * holding the VAPID private key, and Milkbox has no server — nor could the
 * page stand in for one: FCM, APNs and WNS all answer a cross-origin
 * preflight without CORS headers, so a browser cannot POST to a push
 * endpoint at all. Instead the tab keeps its cTag poll running while hidden
 * and hands newly-arrived drops to the service worker to announce.
 *
 * The worker raises the notification rather than the page because only it
 * can see every window at once: with two tabs open, one focused and one
 * hidden, the hidden one has to stay quiet.
 */

import { safeGetItem, safeSetItem } from '../utils/storage';
import type { DropMeta } from '../types';

const ENABLED_KEY = 'milkbox:notify-enabled';
/** Past this many at once, announce a count rather than a stack of cards. */
const MAX_INDIVIDUAL = 3;
const BODY_LIMIT = 140;

export interface NotifyItem {
  id: string;
  title: string;
  body: string;
  /** Scope the drop landed in — lets a notification tap open the right chat.
   *  Optional so old service workers (and old tabs) tolerate the shape. */
  scopeId?: string;
}

/**
 * Notifications need the worker registration's showNotification(), not the
 * page's `new Notification()` — iOS only implements the former, and only
 * for a web app installed to the Home Screen, where this check is false in
 * a plain Safari tab.
 */
export function isNotifySupported(): boolean {
  return (
    typeof Notification !== 'undefined' &&
    'serviceWorker' in navigator &&
    'showNotification' in ServiceWorkerRegistration.prototype
  );
}

export function getNotifyPermission(): NotificationPermission {
  return isNotifySupported() ? Notification.permission : 'denied';
}

/** True when the user opted in *and* the browser still allows it. */
export function isNotifyEnabled(): boolean {
  return getNotifyPermission() === 'granted' && safeGetItem(ENABLED_KEY) === '1';
}

export function setNotifyEnabled(enabled: boolean): void {
  safeSetItem(ENABLED_KEY, enabled ? '1' : '0');
}

/**
 * Ask for permission. Must run inside a user gesture — Safari and Firefox
 * discard the request otherwise.
 */
export async function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!isNotifySupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > BODY_LIMIT ? `${clean.slice(0, BODY_LIMIT - 1)}…` : clean;
}

export function describeDrop(meta: DropMeta): string {
  switch (meta.kind) {
    case 'link':
      return truncate(meta.link?.title || meta.url || 'Link');
    case 'image':
      return meta.text ? truncate(meta.text) : 'Photo';
    case 'file':
      return truncate(meta.text || meta.file?.name || 'File');
    case 'text':
      return truncate(meta.text || 'Drop');
  }
}

/**
 * Hand drops to the worker to announce, oldest first. Does nothing when
 * notifications are off or no worker is registered yet (dev server, or a
 * first load before registration settles) — announcing is never
 * load-bearing, so it must not fail a sync pass.
 */
export async function announceDrops(
  metas: DropMeta[],
  deviceNames: Map<string, string>,
): Promise<void> {
  await announceItems(metas.map(meta => ({
    id: meta.id,
    title: (meta.device.id && deviceNames.get(meta.device.id)) || meta.device.name,
    body: describeDrop(meta),
  })));
}

/**
 * Hand pre-built notification items to the worker, oldest first, collapsing
 * a burst into a single count. Does nothing when notifications are off or no
 * worker is registered yet (dev server, or a first load before registration
 * settles) — announcing is never load-bearing, so it must not fail a sync pass.
 */
export async function announceItems(items: NotifyItem[]): Promise<void> {
  if (!items.length || !isNotifyEnabled()) return;

  const newest = items[items.length - 1];
  const sent: NotifyItem[] =
    items.length > MAX_INDIVIDUAL
      ? [{ id: newest.id, title: 'Milkbox', body: `${items.length} new drops`, ...(newest.scopeId ? { scopeId: newest.scopeId } : {}) }]
      : items;

  // getRegistration() rather than .ready: ready never settles when nothing
  // is registered, which would hang the caller awaiting this.
  const registration = await navigator.serviceWorker.getRegistration();
  const worker = registration?.active;
  if (!worker) return;
  worker.postMessage({ type: 'MILKBOX_NOTIFY', items: sent });
}
