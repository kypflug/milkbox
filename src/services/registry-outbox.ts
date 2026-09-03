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
import { isValidUlid, validateJoinedPointer } from './validate-drop';
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

const MAX_ID = 256;

/** Counters and timestamps: non-negative safe integers, so `attempts + 1`,
 *  `2 ** (attempts - 1)` and the oldest-first sort stay well-defined. */
function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/**
 * Strict shape check for a stored row. Only a well-formed op is ever handed
 * to the drain: a corrupted or partially written row must not turn the
 * backoff bookkeeping (`attempts + 1`, `nextAt`) into NaN, and the op's own
 * fields are what the Graph calls are built from.
 */
export function validateRegistryOp(raw: unknown): RegistryOp | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (!isValidUlid(body.chatId)) return null;
  const enqueuedAt = counter(body.enqueuedAt);
  const attempts = counter(body.attempts);
  const nextAt = counter(body.nextAt);
  if (enqueuedAt === null || attempts === null || nextAt === null) return null;
  const base: RegistryOpBase = { chatId: body.chatId, enqueuedAt, attempts, nextAt };

  switch (body.op) {
    case 'put-pointer': {
      const pointer = validateJoinedPointer(body.pointer);
      if (!pointer || pointer.chatId !== base.chatId) return null;
      return { ...base, op: 'put-pointer', pointer };
    }
    case 'delete-pointer':
      return { ...base, op: 'delete-pointer' };
    case 'delete-member': {
      const driveId = str(body.driveId, MAX_ID);
      const itemId = str(body.itemId, MAX_ID);
      const memberId = str(body.memberId, MAX_ID);
      if (!driveId || !itemId || !memberId) return null;
      return { ...base, op: 'delete-member', driveId, itemId, memberId };
    }
    default:
      return null;
  }
}

/**
 * Every well-formed queued op, oldest first. A row that fails validation,
 * or whose contents disagree with the key it was stored under, can never
 * be acted on — and since the drain removes an op by the key derived from
 * its contents, a mismatched row would otherwise survive every drain as a
 * ghost. Such rows are deleted (best-effort) rather than skipped.
 */
export async function getRegistryOutbox(): Promise<RegistryOp[]> {
  const rows = await getSettingsByPrefix<unknown>(PREFIX);
  const ops: RegistryOp[] = [];
  const junk: string[] = [];
  for (const row of rows) {
    const op = validateRegistryOp(row.value);
    if (op && keyOf(op.op, op.chatId) === row.key) ops.push(op);
    else junk.push(row.key);
  }
  if (junk.length) {
    console.debug('[Chats] Dropping malformed registry outbox rows:', junk);
    await updateSettings([], junk).catch(err => console.debug('[Chats] Could not drop them:', err));
  }
  return ops.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
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
  return patchSetting<unknown>(keyOf(op, chatId), current => {
    const valid = validateRegistryOp(current);
    return valid ? { ...valid, attempts, nextAt } : undefined;
  });
}

/** Whether a chat has a queued op of this kind — the reconcile's guard. */
export function hasPendingRegistryOp(queue: readonly RegistryOp[], op: RegistryOpKind, chatId: string): boolean {
  return queue.some(q => q.op === op && q.chatId === chatId);
}
