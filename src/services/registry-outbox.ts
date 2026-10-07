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
 * each other in the same transaction — the newest intent wins. That goes
 * for both halves of a leave: a join's put-pointer also cancels the
 * delete-member an earlier leave still has queued, which would otherwise
 * remove the member file the join has just written.
 */

import { deleteSetting, getSetting, getSettingsByPrefix, patchSetting, updateSettings } from './db';
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

export type NewRegistryOp =
  | { op: 'put-pointer'; chatId: string; pointer: JoinedChatPointer }
  | { op: 'delete-pointer'; chatId: string }
  | { op: 'delete-member'; chatId: string; driveId: string; itemId: string; memberId: string };

/** The settings rows to write and to delete that record these intents. */
export interface RegistryOpWrites {
  puts: Array<[string, unknown]>;
  deletes: string[];
}

/**
 * What recording these intents writes: each replaces any queued op of the
 * same kind for its chat and cancels what it supersedes. For a caller that
 * has to record them inside a transaction of its own — a leave, which
 * queues its intents only if the chat it removes is still the stay it read
 * (see the coordinator's forgetChat).
 *
 * A put-pointer records a join, and a join supersedes everything an earlier
 * leave of that chat still has queued: its delete-pointer, and its
 * delete-member too. That one names the same file the join wrote
 * (members/<me>.json), and nothing writes the file a second time, so left
 * queued it would take the account off the chat's roster for good.
 */
export function registryOpWrites(entries: readonly NewRegistryOp[]): RegistryOpWrites {
  const writes: RegistryOpWrites = { puts: [], deletes: [] };
  for (const entry of entries) {
    const superseded: RegistryOpKind[] =
      entry.op === 'put-pointer' ? ['delete-pointer', 'delete-member']
        : entry.op === 'delete-pointer' ? ['put-pointer']
          : [];
    const row: RegistryOp = { ...entry, enqueuedAt: Date.now(), attempts: 0, nextAt: 0 };
    writes.puts.push([keyOf(entry.op, entry.chatId), row]);
    for (const op of superseded) writes.deletes.push(keyOf(op, entry.chatId));
  }
  return writes;
}

/** Record an intent. Replaces any queued op of the same kind for the chat
 *  and cancels the ops it supersedes (see registryOpWrites), atomically. */
export function enqueueRegistryOp(entry: NewRegistryOp): Promise<void> {
  const { puts, deletes } = registryOpWrites([entry]);
  return updateSettings(puts, deletes);
}

export function removeRegistryOp(op: RegistryOpKind, chatId: string): Promise<void> {
  return deleteSetting(keyOf(op, chatId));
}

/**
 * The op queued under (op, chatId) as it stands now, if it may be tried at
 * `now`. For the drain, which lists the whole queue first and is a request
 * or more behind that listing by the time it reaches an entry: null when
 * the op has since been cancelled (a join takes back a leave's ops, a leave
 * a join's), been landed by another tab, or been put off (deferRegistryOp,
 * holdRegistryOp).
 */
export async function dueRegistryOp(op: RegistryOpKind, chatId: string, now: number): Promise<RegistryOp | null> {
  const queued = validateRegistryOp(await getSetting<unknown>(keyOf(op, chatId)));
  return queued && queued.op === op && queued.chatId === chatId && queued.nextAt <= now ? queued : null;
}

/** Fallback backoff when a caller hands the write boundary a bad value. */
const DEFER_FALLBACK_MS = 60_000;

/**
 * Note a failed try so the drain leaves the op alone until `nextAt`. The
 * same counter invariant the read path enforces is applied here: a bad
 * value from a caller (a NaN from an odd Retry-After, say) must not turn a
 * valid queued op into a row the next read would drop, so it falls back to
 * the persisted counter plus one and a fixed delay instead.
 *
 * Never brings the op forward: a hold placed while the try was out
 * (holdRegistryOp) outlasts the backoff the try's failure asks for.
 */
export function deferRegistryOp(op: RegistryOpKind, chatId: string, attempts: number, nextAt: number): Promise<void> {
  return patchSetting<unknown>(keyOf(op, chatId), current => {
    const valid = validateRegistryOp(current);
    if (!valid) return undefined;
    return {
      ...valid,
      attempts: counter(attempts) ?? valid.attempts + 1,
      nextAt: Math.max(valid.nextAt, counter(Math.ceil(nextAt)) ?? Date.now() + DEFER_FALLBACK_MS),
    };
  });
}

/**
 * Keep a queued op from being tried before `until`, leaving it queued.
 * Nothing is written when no such op is queued.
 *
 * For a join about to write the member file that an earlier leave still has
 * a removal queued for (see the coordinator's joinChat). Held there, not
 * cancelled, because the join can still fail: a leave whose rejoin never
 * happened would otherwise keep its member file for good. The hold lapses
 * by itself; the op is cancelled by the join's put-pointer, once the join
 * is on record.
 */
export function holdRegistryOp(op: RegistryOpKind, chatId: string, until: number): Promise<void> {
  return patchSetting<unknown>(keyOf(op, chatId), current => {
    const valid = validateRegistryOp(current);
    if (!valid) return undefined;
    return { ...valid, nextAt: Math.max(valid.nextAt, counter(Math.ceil(until)) ?? 0) };
  });
}

/** Whether a chat has a queued op of this kind — the reconcile's guard. */
export function hasPendingRegistryOp(queue: readonly RegistryOp[], op: RegistryOpKind, chatId: string): boolean {
  return queue.some(q => q.op === op && q.chatId === chatId);
}
