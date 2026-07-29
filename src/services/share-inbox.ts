/**
 * Share-target inbox — reads payloads the service worker deposited when the
 * OS share sheet POSTed to /share-target. The SW writes into a dedicated
 * IDB database (it can't import app code), the app drains it here.
 */

import type { SharePayload } from '../types';

const DB_NAME = 'milkbox-share';
const STORE = 'inbox';

function openShareDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Read and clear all pending share payloads. */
export async function drainShareInbox(): Promise<SharePayload[]> {
  try {
    const db = await openShareDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const store = t.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        store.clear();
        resolve((req.result as SharePayload[]) || []);
      };
      t.onerror = () => reject(t.error);
    });
  } catch {
    return [];
  }
}
