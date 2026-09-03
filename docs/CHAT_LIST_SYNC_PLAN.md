# Plan: keep the chat list consistent across a signed-in account's devices

Status: proposal (not yet implemented). Scope: the local chat registry
(`chats` IDB store) and its reconciliation with OneDrive. Drop sync inside a
chat is out of scope and already works.

## Symptom

Sign in on two or more devices with active shared chats. Over time the chat
switcher on each device shows a different list: a chat joined on the phone
never appears on the laptop; a chat you left comes back; a chat you deleted
as host shows "Access ended" on your other device instead of disappearing.

## Why it happens today

OneDrive is the source of truth for the registry. Per account it holds
`Apps/Milkbox/chats/<id>/` for hosted chats and
`Apps/Milkbox/chats-joined/<id>.json` roaming pointers for joined chats.
Every device rebuilds its list from those two folders through
`hydrateChatRegistry()` in `src/services/sync-coordinator.ts`. Five things
about that path make the list drift.

1. **Hydration is additive only.** `hydrateChatRegistry` unions remote
   discoveries into IDB and never removes anything. Leaving, host deletion
   and "Remove from list" are local operations plus a best-effort remote
   write; no other device is ever told to drop the record. The runbook
   promises "chat disappears from the guest's other devices" (§3 Lifecycle)
   but no code implements it.

2. **Registry writes are fire-and-forget.** `joinChat` writes the roaming
   pointer with `.catch(debug)`; `leaveChat` deletes it with `.catch(() => {})`.
   A throttle, a flaky connection or a token hiccup at that moment means the
   join never roams (chat missing on every other device) or the leave never
   sticks (the pointer is re-hydrated on this device within five minutes and
   stays on all others forever). Nothing retries these writes.

3. **`removeChatLocally` leaves the pointer behind.** A guest whose chat went
   "gone" taps Remove from list; the pointer in `chats-joined/` survives, so
   the next hydration pass re-creates the chat as `active`, three polls later
   it goes `gone` again, and the zombie row reappears on every device.

4. **Host deletion is misread on the host's other devices.** After
   `deleteChatHosted` on device A, device B still holds the record; its sync
   404s, crosses `GONE_THRESHOLD` and flips to `gone`, so the host sees
   "Access ended" for their own chat and must remove it by hand on each device.

5. **Discovery is slow and conditional.** The pass is gated to once per
   `HYDRATE_INTERVAL_MS` (5 min) and only runs from `pollAll`, which only
   ticks while the feed screen is visible (or notifications are on). Resume
   is floored at 30 s. A discovered chat then waits its turn in the
   one-background-scope-per-tick rotation before it has drops or members.
   Users read multi-minute skew as "not synced".

Two smaller contributors: a chat's `name` is only ever read at discovery
(a future rename would never propagate), and hydration swallows per-item
download errors while still stamping `lastHydratedAt`, so a pointer that
failed to download waits a full interval before it is retried.

## Fix

### 1. Turn hydration into a reconcile

Rewrite `hydrateChatRegistry` so the remote listings are treated as the
complete registry, with three inputs:

- `hosted` = folder names under `approot:/chats` (from `listHostChats`,
  which must return the raw id set separately from the fully-resolved new
  records so a per-chat descriptor failure does not look like a removal).
- `joined` = pointer ids under `approot:/chats-joined` (same split for
  `listJoinedPointers`).
- `local` = `db.getAllChats()`.

Rules, applied only when both listings succeeded (any listing error aborts
the pass without touching local state, as today):

| Local record | Remote | Action |
|---|---|---|
| absent | hosted or joined | add (today's behaviour), then `requestSync(force)` so it primes notifications and gets drops/members immediately instead of waiting for the rotation |
| `role: host` | not in `hosted` | remove via `clearScopeData` — the host deleted it elsewhere (fixes cause 4) |
| `role: guest`, state `active`/`needs-consent` | not in `joined` | remove via `clearScopeData` — the user left elsewhere (fixes cause 1) |
| `role: guest`, state `gone` | not in `joined` | remove — the user tapped Remove from list elsewhere |
| `role: guest`, state `gone` | in `joined` | keep as `gone`; do **not** re-add as active |
| any | present, `name` differs from descriptor/pointer | patch `name` |

Guards so a reconcile never deletes something the user just did:

- A record with a pending registry write (see §2) is exempt from removal.
- A record created less than `REGISTRY_GRACE_MS` (60 s) ago is exempt; this
  covers the window between `db.putChat` and the pointer landing on OneDrive.
- The `chats-joined` folder returning 404 is a legitimate "no joined chats"
  only when no local guest record has a pending pointer write; otherwise
  skip guest reconciliation for that pass.
- If the removed chat is the active scope, `getActiveScopeId` already falls
  back to private; emit `chats-changed` and let `feed.ts` re-route. Add an
  explicit `chat-removed` coordinator event so the feed screen can show a
  "This chat is no longer on this account" toast instead of silently
  switching.

### 2. Make registry writes durable

Add a small persistent queue, parallel to the drop outbox, for the three
registry writes that must reach OneDrive: `put-pointer`, `delete-pointer`,
`delete-member`. Store it under a settings key (`milkbox:registry-outbox`)
as an array of `{ op, chatId, payload?, attempts, nextAt }`.

- `joinChat` enqueues `put-pointer` before `db.putChat` and drains inline;
  on failure the entry stays queued and the chat is still usable locally.
- `leaveChat` enqueues `delete-pointer` and `delete-member`, then clears
  local scope data. The queue entry carries the drive/item ids it needs
  because the `ChatRecord` is gone.
- `removeChatLocally` also enqueues `delete-pointer` (fixes cause 3).
- `deleteChatHosted` keeps its synchronous folder delete (it is already
  fatal on failure) but no longer needs a pointer op.
- `pollAll` drains the queue every tick with the same backoff and
  `Retry-After` handling as the drop outbox. Terminal 404/410 on a delete is
  success. `needs-consent` (ConsentRequiredError) leaves the entry queued
  without counting an attempt.
- The reconcile in §1 consults this queue: a chat with a queued
  `put-pointer` is never removed; a chat with a queued `delete-pointer` is
  never re-added.

### 3. Make discovery fast and cheap

Replace the five-minute timer gate with a cTag gate, the same mechanism
`isDeviceRegistryDirty` already uses for `devices/`:

- Track `milkbox:registry-ctag:hosted` (cTag of `approot:/chats`) and
  `milkbox:registry-ctag:joined` (cTag of `approot:/chats-joined`).
- Each `pollAll` tick does one `$select=cTag` GET per registry folder (two
  tiny requests; alternate them across ticks if the request budget matters)
  and runs the reconcile only when a cTag moved. Note the `chats/` cTag also
  moves on every drop in every hosted chat, so the listing GET will run more
  often for hosts than strictly needed; it is a single small children
  listing, which is acceptable. A 404 on either folder counts as "unchanged
  and empty".
- Keep a slow full pass (every 30 min) as a safety net for cTag anomalies.
- Resume (`setupResumeHandler`) drops the 30 s floor for the cTag check
  itself; the floor only protects the full listing.
- Extend polling so hydration also runs while the feed is hidden when the
  document is a standalone PWA with notifications on (already the case) and
  on `online` events after a disconnect.

Expected latency after this: another device sees a create/join/leave within
one poll tick (45 s) while foregrounded, or immediately on resume.

### 4. UI follow-through

- `chat-switcher.ts`: nothing structural; it already repaints on
  `chats-changed`. Add the `chat-removed` toast wiring in `feed.ts`.
- Manage sheet copy for Leave is already accurate ("stop seeing it on your
  devices"); Delete copy can stay.
- Settings › About: no change.

### 5. Types and storage

- `ChatRecord`: add `registeredAt: number` (local insert time, for the grace
  window). Optional so existing v3 records need no migration.
- New settings keys: `milkbox:registry-outbox`, `milkbox:registry-ctag:*`.
  Add them to `clearAllData` implicitly (settings store is cleared) and make
  sure `clearScopeData` does not touch them.
- No IDB version bump.

## Implementation order

1. Registry outbox (§2) with unit-style checks against the DEV harness
   (`window.__milkboxChatDev`): join with the network blocked, confirm the
   pointer lands after reconnect.
2. Reconcile (§1) behind the existing timer gate; verify the removal rules
   with two devices before touching cadence.
3. cTag gating and resume changes (§3).
4. Feed toast and event (§4), runbook updates (§3 Lifecycle rows become
   testable with expected latencies), README "Shared chats" sentence about
   roaming.

Each step ships independently and is safe to revert on its own.

## Verification (add to `docs/MULTIPLAYER_RUNBOOK.md` §3)

- [ ] GUEST joins on phone; laptop (foregrounded) shows the chat within one
      poll tick and it already has drops and the member roster.
- [ ] GUEST joins on phone with the network cut right after the join
      completes locally; reconnect; laptop shows the chat without a manual
      re-join.
- [ ] GUEST leaves on laptop; phone removes the row within one tick; the
      chat never reappears on the laptop after five minutes.
- [ ] GUEST removes a "gone" chat from the list on one device; it is removed
      on the other and never resurrects as active.
- [ ] HOST deletes on desktop; the host's phone removes the row (not
      "Access ended"); the guest still flips to "Access ended".
- [ ] HOST creates a chat on the phone; desktop shows it within one tick.
- [ ] Sign-out/sign-in on a device rebuilds exactly the remote list,
      including `gone` chats only if their pointer still exists.
- [ ] A throttled (429) pass leaves every local chat intact.

## Risks

- **Over-deletion.** The reconcile can remove a chat the user still wants
  if a listing lies (empty page, partial result). Mitigations: abort on any
  listing error, the grace window, the pending-write exemption, and the
  fact that a removed chat is cheaply re-added by the next pass if the
  pointer or folder is in fact still there.
- **Request budget.** Two extra cTag GETs per tick. Alternate the two
  folders across ticks if this shows up in throttling.
- **Older builds.** Old clients ignore the new settings keys and never read
  `registeredAt`; the on-disk JSON in OneDrive is unchanged.
