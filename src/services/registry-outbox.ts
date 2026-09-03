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
 * Storage is one settings row PER OP, keyed by (op, chatId), so every
 * enqueue, defer and removal is a single-key write and two tabs can never
 * lose each other's intent. A put and a delete for the same chat cancel
 * each other in the same transaction — the newest intent wins.
 */

import { deleteSetting, getSettingsByPrefix, patchSetting, updateSettings } from './db';
import type { JoinedChatPointer } from '../types';

const PREFIX = 'milkbox:registry-op:';

interface RegistryOpBase {
  chatId: string;
  /** Insertion time — the drain runs oldest first. */
  enqueuedAt: number;
  attempts: number;
  /** Earliest time the drain may try this op again (backoff / Retry-After). */
  nextAt: number;
}

export type RegistryOp =
  | (RegistryOpBase & { op: 'put-pointer'; pointer: JoinedChatPointer })
  | (RegistryOpBase & { op: 'delete-pointer' })
  | (RegistryOpBase & { op: 'delete-member'; driveId: string; itemId: string; memberId: string });

export type RegistryOpKind = RegistryOp['op'];

const keyOf = (op: RegistryOpKind, chatId: string) => `${PREFIX}${op}:${chatId}`;

export async function getRegistryOutbox(): Promise<RegistryOp[]> {
  const rows = await getSettingsByPrefix<RegistryOp>(PREFIX);
  return rows
    .map(r => r.value)
    .filter((v): v is RegistryOp => typeof v === 'object' && v !== null && typeof v.op === 'string')
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

type NewRegistryOp =
  | { op: 'put-pointer'; chatId: string; pointer: JoinedChatPointer }
  | { op: 'delete-pointer'; chatId: string }
  | { op: 'delete-member'; chatId: string; driveId: string; itemId: string; memberId: string };

/** Record an intent. Replaces any queued op of the same kind for the chat
 *  and cancels the opposite pointer op, atomically. */
export function enqueueRegistryOp(entry: NewRegistryOp): Promise<void> {
  const opposite: RegistryOpKind | null =
    entry.op === 'put-pointer' ? 'delete-pointer'
      : entry.op === 'delete-pointer' ? 'put-pointer'
        : null;
  const row: RegistryOp = { ...entry, enqueuedAt: Date.now(), attempts: 0, nextAt: 0 };
  return updateSettings(
    [[keyOf(entry.op, entry.chatId), row]],
    opposite ? [keyOf(opposite, entry.chatId)] : [],
  );
}

export function removeRegistryOp(op: RegistryOpKind, chatId: string): Promise<void> {
  return deleteSetting(keyOf(op, chatId));
}

/** Note a failed try so the drain leaves the op alone until `nextAt`. */
export function deferRegistryOp(op: RegistryOpKind, chatId: string, attempts: number, nextAt: number): Promise<void> {
  return patchSetting<RegistryOp>(keyOf(op, chatId), current =>
    current ? { ...current, attempts, nextAt } : undefined,
  );
}

/** Whether a chat has a queued op of this kind — the reconcile's guard. */
export function hasPendingRegistryOp(queue: readonly RegistryOp[], op: RegistryOpKind, chatId: string): boolean {
  return queue.some(q => q.op === op && q.chatId === chatId);
}
