# Shared chats — operator runbook

Manual steps for shipping and validating the multiplayer ("shared chats")
feature. Code alone is not enough: the Azure app registration needs a new
delegated permission, and several Graph behaviors on *consumer* OneDrive are
documented loosely enough that they must be validated live with two real
Microsoft accounts before (and after) rollout.

## 1. Azure app registration (do this first)

The app requests `Files.ReadWrite` incrementally — only when a user first
creates or joins a shared chat. Register the permission:

1. [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** →
   **App registrations** → **Milkbox** (client id `2746e456-8b09-4d41-94df-564b79d791ed`,
   see `src/services/auth-config.ts`).
2. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions** → check **`Files.ReadWrite`** → **Add permissions**.
3. Verify `Files.ReadWrite.AppFolder`, `User.Read`, and `offline_access`
   are still listed. Do **not** remove `Files.ReadWrite.AppFolder` — solo
   users stay on it.
4. No admin consent (consumer app — each user consents individually at the
   incremental prompt).
5. Redirect URIs are unchanged: `http://localhost:5173/` and
   `https://milkbox.stuntcamp.app/` (SPA platform).

## 2. Graph behavior validation (two consumer accounts)

Several consumer-OneDrive behaviors are assumed with fallbacks; validate
them live and record the answers here. Use the DEV console harness: run
`npm run dev`, sign in, and use `window.__milkboxChatDev` (usage notes at the
top of `src/dev/chat-dev.ts`), or Graph Explorer.

| # | Question | Why it matters | Result |
|---|---|---|---|
| a | Does `GET /drives/{hostDrive}/items/{dropsFolder}/delta` work for a **guest** on a redeemed share? | Primary sync path. If refused, the app silently falls back to a `children` listing per chat (`syncStrategy: 'listing'` — watch for the `[Sync] Delta unsupported` console.debug). | ☐ |
| b | Does a path-form PUT (`…/items/{chatFolder}:/drops/x.json:/content`) by a guest auto-create intermediate folders? | Guest sends. Folders are pre-created at chat creation, so only `files/<ulid>/` nesting depends on it. | ☐ |
| c | Does `createLink` work with an AppFolder-only token on an approot child? | If yes, hosts could avoid the broad consent entirely (future optimization; the shipped flow consents hosts at create time). | ☐ |
| d | After guests redeem the link, does `GET …/permissions` show them as **individual grants** or only as grantees of the one link permission? | Decides whether per-member **Remove** works. The app already degrades honestly: if no individual grant exists it tells the host to reset the link instead. | ☐ |
| e | Does deleting the link permission (**Reset link**) revoke members who joined through it? | Sets the truthful copy for Reset link (the app's confirm copy already warns members may need the new link). | ☐ |

## 3. Two-account end-to-end test matrix

Accounts: HOST and GUEST (both personal Microsoft accounts). Test the
switcher/header in all four layout combos where noted: window-controls-overlay
× pane (≥800×600) on Windows, plus a phone.

Setup & consent
- [ ] Solo account that never touches chats is **never** shown the broad consent.
- [ ] HOST creates a chat → consent interstitial → Microsoft prompt appears **exactly once**; invite sheet opens with QR + link.
- [ ] The chats button (top right of the header) opens the switcher dialog and is clickable in all four WCO × pane layout combos (in window-controls-overlay it must sit beside — never under — the window controls); the unread badge shows on it.
- [ ] Consent denial (cancel at Microsoft) lands the "You can try again anytime" toast — no redirect loop.
- [ ] iOS standalone PWA: consent opens the in-app sheet; closing it resumes the create/join without a reload.

Join
- [ ] GUEST scans the QR with the iOS camera → Milkbox opens → signs in (invited sign-in copy) → joins → lands in the chat.
- [ ] GUEST on desktop opens the link signed-out → **one** Microsoft screen (sign-in with the OneDrive consent folded in via extraScopesToConsent, disclosed on the invited sign-in sheet first) → join resumes automatically with no interstitial afterwards. Cancelling that screen returns to the invited sign-in sheet. (The silent auto-redirect recovery path deliberately stays base-tier — it never shows the disclosure — and uses the interstitial as before.)
- [ ] Join while offline shows the offline copy and completes on next launch.
- [ ] A rotated/dead link shows "This invite link doesn't work anymore."
- [ ] HOST opens their **own** invite link on a second device → registers as host (no self-member file, host affordances present).
- [ ] GUEST's **second device** shows the joined chat without re-joining (roaming pointer), after sign-in + one sync.

Messaging
- [ ] Text, link, image, file (>4 MB for the upload session) in both directions.
- [ ] Attribution shows author names; own drops right-aligned for each side.
- [ ] GUEST can edit/delete only their own drops; HOST additionally sees delete on GUEST drops; GUEST sees no delete on HOST drops.
- [ ] Moderation race: GUEST queues an edit offline, HOST deletes that drop, GUEST reconnects → edit is discarded with the conflict toast; the drop stays deleted (no resurrection).
- [ ] Offline queue in a chat: SENDING/FAILED overlays, retry, discard.
- [ ] Unread badge increments on the other account (including from an author whose clock is skewed hours behind) and clears on opening the chat.
- [ ] Notifications (iOS standalone, notify on): "<chat> · <author>" fires for a backgrounded app; tapping opens the right chat; joining a chat with history does **not** replay the backlog.

Lifecycle
- [ ] Leave (guest): chat disappears locally and from the guest's other devices; member file best-effort removed.
- [ ] Remove member (host): per matrix 2d — either removes access, or shows the reset-link guidance.
- [ ] Reset link: old link dead for new joins; record 2e's member effect.
- [ ] Delete chat (host): guest flips to "Access ended" read-only within ~3 poll cycles; Remove from list clears it.
- [ ] Sign-out wipes chats, drops, and per-scope state; sign-in restores hosted chats + joined pointers from OneDrive.

Migration & upgrade
- [ ] An install with existing v2 data upgrades: private feed intact, thumbnails re-fetch, queued outbox drops still send.
- [ ] Two-tab upgrade: the new-build tab upgrades cleanly; the old-build tab degrades without corrupting and recovers on reload.

## 4. Deployment (stuntcamp)

1. `npm run build` green; merge to `main`; take the **full** SHA.
2. stuntcamp PR updating `registry/apps/milkbox.json` → `build.ref` = the SHA
   (see README "Deployment"). No palette/manifest/icon changes in this feature
   → no asset regeneration, `accent`/`thumbnail` unchanged.
3. Smoke on the production origin (the consent redirect URI must match).

## 5. Copy & governance already updated in this change (verify on review)

- `README.md` — scope story now describes the incremental `Files.ReadWrite` consent.
- `.github/copilot-instructions.md` — the "never broader scopes" rule now names
  the sanctioned share tier and its consent gate.
- `src/screens/sign-in.ts` fine print, settings **About** section.

## 6. Rollback

Revert the stuntcamp `build.ref` pin. Notes:

- Drop JSON is forward-safe: old clients ignore the optional `author` field
  and never look inside `chats/` / `chats-joined/`.
- IndexedDB **v3 does not downgrade**. A client that ran the new build fails
  `openDb` on a pre-v3 build. Do not roll back to a pre-migration SHA once
  this has shipped; if forced to, users recover by sign-out/sign-in (OneDrive
  is the source of truth — a cleared local DB fully resyncs).
- Consent already granted to `Files.ReadWrite` is harmless to old builds
  (they only request the AppFolder scope).
