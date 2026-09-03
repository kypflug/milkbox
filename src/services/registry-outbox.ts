/**
 * The registry outbox — the durable queue for the small OneDrive writes that
 * make a chat's membership follow the account to its other devices:
 *
 *   put-pointer     chats-joined/<chatId>.json written after a join
 *   delete-pointer  chats-joined/<chatId>.json removed after leave/remove
 *   delete-member   chats/<id>/members/<me>.json removed after leave
 *
 * These used to be fire-and-forget. A join whose pointer PUT was throttled
 * never roamed; a leave whose pointer DELETE failed came back on every
 * device at the next registry pass. Each intent now lives here until the
 * write lands, and the registry reconcile in the coordinator consults the
 * queue so a chat with a pending put is never removed and one with a
 * pending delete is never re-added.
 *
 * Storage is one settings row holding the whole (tiny) queue: at most one
 * entry per (op, chatId), and a put and a delete for the same chat cancel
 * each other — the newest intent wins.
 */

import { deleteSetting, getSetting, putSetting } from './db';
import type { JoinedChatPointer } from '../types';

const KEY = 'milkbox:registry-outbox';

interface RegistryOpBase {
  chatId: string;
  attempts: number;
  /** Earliest time the drain may try this op again (backoff / Retry-After). */
  nextAt: number;
}

export type RegistryOp =
  | (RegistryOpBase & { op: 'put-pointer'; pointer: JoinedChatPointer })
  | (RegistryOpBase & { op: 'delete-pointer' })
  | (RegistryOpBase & { op: 'delete-member'; driveId: string; itemId: string; memberId: string });

export type RegistryOpKind = RegistryOp['op'];

export async function getRegistryOutbox(): Promise<RegistryOp[]> {
  const queue = await getSetting<RegistryOp[]>(KEY);
  return Array.isArray(queue) ? queue : [];
}

async function saveRegistryOutbox(queue: RegistryOp[]): Promise<void> {
  if (queue.length === 0) await deleteSetting(KEY);
  else await putSetting(KEY, queue);
}

type NewRegistryOp =
  | { op: 'put-pointer'; chatId: string; pointer: JoinedChatPointer }
  | { op: 'delete-pointer'; chatId: string }
  | { op: 'delete-member'; chatId: string; driveId: string; itemId: string; memberId: string };

/** Record an intent. Replaces any queued op of the same kind for the chat
 *  and cancels the opposite pointer op, so the queue holds the latest wish. */
export async function enqueueRegistryOp(entry: NewRegistryOp): Promise<void> {
  const cancels: RegistryOpKind[] =
    entry.op === 'put-pointer' ? ['put-pointer', 'delete-pointer']
      : entry.op === 'delete-pointer' ? ['put-pointer', 'delete-pointer']
        : ['delete-member'];
  const queue = (await getRegistryOutbox()).filter(
    q => !(q.chatId === entry.chatId && cancels.includes(q.op)),
  );
  queue.push({ ...entry, attempts: 0, nextAt: 0 });
  await saveRegistryOutbox(queue);
}

export async function removeRegistryOp(op: RegistryOpKind, chatId: string): Promise<void> {
  const queue = await getRegistryOutbox();
  const next = queue.filter(q => !(q.op === op && q.chatId === chatId));
  if (next.length !== queue.length) await saveRegistryOutbox(next);
}

/** Note a failed try so the drain leaves the op alone until `nextAt`. */
export async function deferRegistryOp(op: RegistryOpKind, chatId: string, attempts: number, nextAt: number): Promise<void> {
  const queue = await getRegistryOutbox();
  const entry = queue.find(q => q.op === op && q.chatId === chatId);
  if (!entry) return;
  entry.attempts = attempts;
  entry.nextAt = nextAt;
  await saveRegistryOutbox(queue);
}

/** Whether a chat has a queued op of this kind — the reconcile's guard. */
export function hasPendingRegistryOp(queue: readonly RegistryOp[], op: RegistryOpKind, chatId: string): boolean {
  return queue.some(q => q.op === op && q.chatId === chatId);
}
