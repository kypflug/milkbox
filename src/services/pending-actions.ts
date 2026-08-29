/**
 * The one pending-action record for flows that survive a consent redirect
 * (desktop: full page navigation; iOS standalone: the in-app auth sheet) or
 * a sign-in — persisted in IndexedDB because iOS wipes localStorage.
 *
 * Exactly one record exists at a time: a join and a create can't be pending
 * together, which is what makes resumption unambiguous (the adversarial
 * review flagged dual pending mechanisms as a double-run hazard).
 */

import { deleteSetting, getSetting, putSetting } from './db';

const KEY = 'milkbox:pending-action';
const STALE_MS = 15 * 60_000;

export type PendingAction =
  | { type: 'join'; token: string; createdAt: number; consentRequested?: boolean }
  | { type: 'create-chat'; name: string; createdAt: number; consentRequested?: boolean }
  | { type: 'reconnect'; chatId: string; createdAt: number; consentRequested?: boolean };

export async function getPendingAction(): Promise<PendingAction | null> {
  const action = await getSetting<PendingAction>(KEY);
  if (!action) return null;
  if (Date.now() - action.createdAt > STALE_MS) {
    await deleteSetting(KEY);
    return null;
  }
  return action;
}

export function setPendingAction(action: PendingAction): Promise<void> {
  return putSetting(KEY, action);
}

export function clearPendingAction(): Promise<void> {
  return deleteSetting(KEY);
}
