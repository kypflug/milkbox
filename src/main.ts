import { getAccountId, initAuth, isSignedIn, tryRecoverAuth, refreshTokenOnResume, hasAccountHint, signInWithHint } from './services/auth';
import { clearMsalCacheBackup, restoreMsalCacheIfNeeded, setupBackgroundBackup } from './services/msal-cache-backup';
import { initBroadcast, onBroadcast, postBroadcast } from './services/broadcast';
import { drainShareInbox } from './services/share-inbox';
import * as coordinator from './services/sync-coordinator';
import { resumePendingAction, startCreateChatFlow, startJoinFlow, startReconnectFlow } from './services/chat-flows';
import { setPendingAction } from './services/pending-actions';
import { isValidShareToken } from './services/chats';
import { renderSignIn } from './screens/sign-in';
import { renderFeed, applySharePayload, hasUnsentDraft, isReloadAsked, showReloadPrompt, teardownScreenListeners } from './screens/feed';
import { closeAllModals, showManageSheet } from './screens/chat-sheets';
import { mountChatMenu, type ChatSwitcherHandlers } from './components/chat-switcher';
import { showToast } from './components/toast';
import { applyTheme } from './theme';
import { escapeHtml } from './utils/storage';
import { PRIVATE_SCOPE, scopeIdOf, type Scope, type ScopeId } from './types';
import { registerSW } from 'virtual:pwa-register';

const app = document.getElementById('app')!;

/**
 * Service worker update coordination.
 * With registerType: 'prompt', the new SW waits until we explicitly call
 * updateSW(). We defer activation until after handleRedirectPromise()
 * (initAuth) completes to avoid interrupting auth redirects, and while a
 * share payload is pending so a reload can't eat it.
 */
let pendingSwUpdate: (() => Promise<void>) | null = null;
let deferSwUpdate = false;
const updateSW = registerSW({
  onNeedRefresh() {
    if (!authBootComplete || deferSwUpdate) {
      pendingSwUpdate = updateSW;
    } else {
      updateSW().catch(() => {});
    }
  },
  onOfflineReady() {
    console.debug('[SW] App ready for offline use');
  },
});
let authBootComplete = false;
/** Set when this launch came from an invite link — flavors the sign-in copy. */
let invitedSignIn = false;

boot(app).catch(err => {
  console.error('Boot failed:', err);

  let errorMessage = 'Failed to initialize. Please reload.';
  let errorDetails = '';

  if (err instanceof Error) {
    const errMsg = err.message.toLowerCase();
    if (errMsg.includes('upgrade is blocked')) {
      // A window on the previous version still has the store open (db.ts).
      errorMessage = 'Milkbox is open in another window';
      errorDetails = 'This version needs to update its local storage first. Close other Milkbox windows, then reload.';
    } else if (errMsg.includes('localstorage') || errMsg.includes('quota') || errMsg.includes('storage')) {
      errorMessage = 'Storage access blocked';
      errorDetails = 'Milkbox needs storage access to work. Please disable Private Browsing or use a different browser.';
    } else if (errMsg.includes('network') || errMsg.includes('fetch') || errMsg.includes('timeout')) {
      errorMessage = 'Connection failed';
      errorDetails = 'Could not connect to Microsoft services. Check your internet connection and try again.';
    } else if (errMsg.includes('msal') || errMsg.includes('auth') || errMsg.includes('token')) {
      errorMessage = 'Authentication error';
      errorDetails = 'There was a problem with sign-in. Please reload and try again.';
    }
  }

  app.innerHTML = `
    <div class="boot-error-screen">
      <div class="boot-titlebar" aria-hidden="true"></div>
      <div class="boot-error-content">
        <p class="boot-error-title">${escapeHtml(errorMessage)}</p>
        ${errorDetails ? `<p class="boot-error-details">${escapeHtml(errorDetails)}</p>` : ''}
        <button class="boot-error-reload" id="bootErrorReload">Reload</button>
      </div>
    </div>
  `;
  document.getElementById('bootErrorReload')?.addEventListener('click', () => window.location.reload());
});

/** The invite this page was opened with, if its link holds one that can be used. */
function inviteInAddressBar(): string | null {
  const raw = location.hash.startsWith('#join=') ? decodeInvite(location.hash.slice(6)) : null;
  return raw && isValidShareToken(raw) ? raw : null;
}

async function boot(app: HTMLElement): Promise<void> {
  applyTheme();
  trackWindowControlsSide();
  // Before the first await: a broadcast is not replayed, so a sign-out in
  // another tab while this one restores its token cache or starts MSAL
  // would be missed — and this page would enter the app as the account that
  // was just signed out.
  watchForSignOutElsewhere(app);

  // Restore MSAL cache from IndexedDB if iOS wiped localStorage
  const cacheRestored = await restoreMsalCacheIfNeeded();
  if (cacheRestored) {
    console.info('[Boot] MSAL cache restored from IndexedDB backup');
  }
  // Told of a sign-out while that read was pending: this page is signed out
  // before MSAL has started, so it is not started. It would read whatever
  // account the other tab's logout has yet to clear, and take in a sign-in
  // redirect, for a page that has already been told to stop. (A redirect
  // left in the address bar is for the next load to deal with, and so is
  // an invite link: the screen greets as invited, and its button reloads.)
  if (signedOutElsewhere) {
    invitedSignIn = inviteInAddressBar() !== null;
    showSignedOutElsewhere(app);
    return;
  }

  // initAuth() returns a non-null AuthenticationResult when this page load
  // is the result of a loginRedirect completing. Told of a sign-out while
  // MSAL is starting, it stops short of taking that redirect in.
  const redirectResponse = await initAuth(false, () => signedOutElsewhere);

  // Auth redirect handling is done — safe to activate pending SW update
  authBootComplete = true;
  if (pendingSwUpdate && !deferSwUpdate) {
    pendingSwUpdate().catch(() => {});
    pendingSwUpdate = null;
  }

  // An invite link opened while signed out: park the join (IDB — survives
  // the sign-in redirect and iOS storage wipes) and greet as invited.
  const invitedToken = inviteInAddressBar();
  // Signed out in another tab while this one was starting: whatever account
  // MSAL has just loaded is on its way out, so this page is not signed in.
  const signedIn = !signedOutElsewhere && (Boolean(redirectResponse?.account) || isSignedIn());
  if (invitedToken && !signedIn) {
    invitedSignIn = true;
    // Not while another tab is signing out: its wipe would refuse this
    // write, or take the parked invite with it a moment later. The link
    // stays in the address bar instead, for the next load to pick up.
    if (!signedOutElsewhere) {
      try {
        await setPendingAction({ type: 'join', token: invitedToken, createdAt: Date.now(), parkedSignedOut: true });
      } catch (err) {
        if (!signedOutElsewhere) throw err;
      }
      // Parked for sure only if no sign-out arrived while it was written.
      if (!signedOutElsewhere) history.replaceState(null, '', '/');
    }
  }
  if (signedOutElsewhere) {
    // Its screen is up already; drawn again now that this is known to be an
    // invite or not.
    showSignedOutElsewhere(app);
    return;
  }

  if (signedIn) {
    clearAutoRedirectMark();
    await enterApp(app);
  } else if (cacheRestored || hasAccountHint()) {
    // Account evidence exists but MSAL can't find valid accounts — try
    // silent recovery before falling back to the sign-in screen.
    console.debug('[Boot] Account evidence exists (cacheRestored=%s, hint=%s) — attempting recovery',
      cacheRestored, hasAccountHint());
    const recovered = await tryRecoverAuth();
    // The evidence was the account another tab has just signed out: neither
    // enter the app as it nor send the user to sign in to it again.
    if (signedOutElsewhere) return;
    if (recovered && isSignedIn()) {
      console.info('[Boot] Auth recovered without user interaction');
      clearAutoRedirectMark();
      await enterApp(app);
    } else if (canAutoRedirect()) {
      // Auto-redirect to Microsoft login with the saved loginHint; the
      // Microsoft session cookie is usually still valid so this completes
      // without the user tapping anything.
      console.info('[Boot] Silent recovery failed — auto-redirecting to Microsoft login');
      markAutoRedirected();
      await attemptAutoRedirect(app);
    } else {
      renderSignIn(app, () => void enterApp(app), { invited: invitedSignIn });
    }
  } else {
    renderSignIn(app, () => void enterApp(app), { invited: invitedSignIn });
  }
}

// ─── Auto-redirect helpers (iOS session recovery) ───

/**
 * Flag which side the window controls occupy in a window-controls-overlay
 * install. The overlay rect starts after the controls, so a non-zero x means
 * they sit on the left — macOS traffic lights, or a right-to-left Windows
 * install — and the feed header moves its bottle to the opposite rail rather
 * than tucking it against them. Asking for the geometry beats sniffing the
 * platform: it answers the question we actually care about.
 */
function trackWindowControlsSide(): void {
  const overlay = navigator.windowControlsOverlay;
  if (!overlay) return;

  const apply = () => {
    const controlsOnLeft = overlay.visible && overlay.getTitlebarAreaRect().x > 0;
    document.documentElement.toggleAttribute('data-controls-left', controlsOnLeft);
  };

  apply();
  overlay.addEventListener('geometrychange', apply);
}

const AUTO_REDIRECT_KEY = 'milkbox:auto-redirect';

/** True if we haven't already attempted an auto-redirect this session. */
function canAutoRedirect(): boolean {
  try { return !sessionStorage.getItem(AUTO_REDIRECT_KEY); }
  catch { return false; }
}

function markAutoRedirected(): void {
  try { sessionStorage.setItem(AUTO_REDIRECT_KEY, '1'); }
  catch { /* sessionStorage may be unavailable */ }
}

function clearAutoRedirectMark(): void {
  try { sessionStorage.removeItem(AUTO_REDIRECT_KEY); }
  catch { /* */ }
}

/**
 * Auto-redirect to Microsoft login with the saved loginHint.
 *
 * On iOS standalone PWA, loginRedirect opens an in-app Safari sheet rather
 * than navigating the page. A visibilitychange handler re-checks auth when
 * the sheet closes. On regular browsers the page navigates away and boot()
 * runs again on return.
 */
async function attemptAutoRedirect(app: HTMLElement): Promise<void> {
  const handler = async () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', handler);

    try {
      const response = await initAuth(true);
      if (response?.account || isSignedIn()) {
        clearAutoRedirectMark();
        await enterApp(app);
        return;
      }
    } catch { /* fall through */ }

    renderSignIn(app, () => void enterApp(app), { invited: invitedSignIn });
  };
  document.addEventListener('visibilitychange', handler);

  try {
    // Base scopes only — this path never showed the invited disclosure, so
    // the shared-chats consent stays with the in-app interstitial here.
    await signInWithHint();
  } catch {
    document.removeEventListener('visibilitychange', handler);
    renderSignIn(app, () => void enterApp(app), { invited: invitedSignIn });
  }
}

/** Another tab signed this account out: this page shows the sign-in screen and does nothing more. */
let signedOutElsewhere = false;

/** Stop this page and put the sign-in screen up — whatever it was in the middle of drawing. */
function showSignedOutElsewhere(app: HTMLElement): void {
  teardownScreenListeners(); // the lightbox with it
  chatUiTeardown?.();
  chatUiTeardown = null;
  // Sheets hang off <body>: left open they would keep showing the signed-out
  // account's chat members or invite link over the sign-in screen.
  closeAllModals();
  renderSignIn(app, () => location.reload(), { invited: invitedSignIn });
}

/**
 * Listen for a sign-out in another tab, from the first moment of boot to the
 * end of the page. Once that tab's wipe lands, a page that had already
 * opened the store is on a superseded epoch and its writes are refused (see
 * db.ts); one that has not opened it yet would simply start on whatever the
 * store then holds. Neither is something to lean on — the wipe is bounded
 * and can be given up on — so either way this page must not carry on as it
 * was, nor start up as if nothing had happened.
 */
function watchForSignOutElsewhere(app: HTMLElement): void {
  initBroadcast();
  onBroadcast(event => {
    if (event.type !== 'auth-changed' || event.signedIn) return;
    // Not a reload: the other tab's logout may not have cleared the token
    // cache yet, and a reload would boot straight back into this account.
    signedOutElsewhere = true;
    coordinator.shutdown();
    // This tab's backup hooks (pagehide, going hidden) may be armed and the
    // token cache is still in localStorage until that logout finishes: a
    // backup from here would recreate the snapshot sign-out just deleted.
    void clearMsalCacheBackup({ told: true });
    showSignedOutElsewhere(app);
  });
}

/** Transition to the main app: routing, share target, and resume handler. */
async function enterApp(app: HTMLElement): Promise<void> {
  // Told of a sign-out since it loaded, this page is shut down for good (see
  // watchForSignOutElsewhere) and must not claim the store. If it has been
  // signed in again in place — the iOS sign-in sheet returns to the same
  // page — it starts over.
  if (signedOutElsewhere) {
    location.reload();
    return;
  }
  // Subscribed before any await here: another tab re-syncing from scratch
  // must not be missed while this one is still starting up. This page's view
  // of local storage is then superseded and its writes are refused (see the
  // store epoch in db.ts).
  onBroadcast(event => {
    if (event.type !== 'store-reset') return;
    // This page has to reload before it can write again — but not over
    // something the user hasn't sent yet. Then it is their call.
    if (hasUnsentDraft()) {
      showReloadPrompt('Milkbox was re-synced in another window. Reload this one when you’re ready.');
    } else {
      location.reload();
    }
  });
  postBroadcast({ type: 'auth-changed', signedIn: true });
  try {
    // Before anything reads the store: data left by a different account goes.
    const accountId = getAccountId();
    if (accountId) {
      await coordinator.claimStoreFor(accountId);
      // The sign-out landed while the claim was under way. If its wipe ran
      // first, the claim has just replaced the "signed out" marker with this
      // account's: put the wipe back, so that whatever is written behind it
      // is still cleared, not adopted, when an account next signs in.
      if (signedOutElsewhere) await coordinator.wipeForSignOut();
    }
    await route(app);
    window.addEventListener('hashchange', () => void route(app));
    // Anything a consent redirect / sign-in / iOS sheet interrupted — unless
    // this launch's own invite link has just started a join: that flow has
    // parked the same join itself, and resuming it here would run it twice.
    if (!signedOutElsewhere && !joinStartedFromLink) await resumePendingAction();
    if (!signedOutElsewhere) await handleShareTarget();
  } catch (err) {
    // Once another tab has signed out, storage refuses this page's writes.
    // A start-up step failing on that is expected, not a failed boot.
    if (!signedOutElsewhere) throw err;
  }
  if (signedOutElsewhere) {
    showSignedOutElsewhere(app);
    return;
  }
  setupResumeHandler();
  setupBackgroundBackup();
  // Warm the author identity, land any registry write a previous session
  // left queued, and reconcile the local registry with the chats this
  // account has elsewhere (hosted folders + roaming pointers).
  void coordinator.ensureMe();
  void coordinator.catchUpRegistry();
  // A delete the last session left backing off is not made to wait out the
  // rest of it: the app starting is as good a moment as coming back to it.
  void coordinator.retryDeferredDeletes();

  // A notification tap on an already-open window arrives as a worker
  // message — route to the scope it named.
  navigator.serviceWorker?.addEventListener('message', e => {
    const data = e.data as { type?: string; scopeId?: string } | undefined;
    if (data?.type !== 'MILKBOX_OPEN_SCOPE' || typeof data.scopeId !== 'string') return;
    const scopeId = data.scopeId;
    if (scopeId === 'private' || /^chat:[0-9A-HJKMNP-TV-Z]{26}$/.test(scopeId)) {
      selectScope(app, scopeId);
    }
  });

  if (import.meta.env.DEV) {
    const dev = await import('./dev/chat-dev');
    dev.installChatDevHarness();
  }
}

/** route() found an invite link in the address bar and started its join. */
let joinStartedFromLink = false;

/** The token of an invite link, or null when its escaping is broken. */
function decodeInvite(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** Only the very first empty-hash route restores the remembered scope —
 *  after that, an empty hash means the user chose the private feed. */
let restoredActiveScope = false;
let chatUiTeardown: (() => void) | null = null;

async function route(app: HTMLElement): Promise<void> {
  if (signedOutElsewhere) return;
  // Waiting to be reloaded after another window reset the store (the user
  // has been asked, on the reset's broadcast or on a write it refused): no
  // route can go through. Its first write would be refused, and by then
  // the screen's listeners, the composer's among them, would have been
  // taken down with nothing drawn in their place. The screen is left
  // whole, its draft with it, and the user is asked again.
  if (isReloadAsked()) {
    // An invite link opened here is not started, since a join writes to the
    // store, and it is not carried across the reload: the user is told.
    showReloadPrompt(
      inviteInAddressBar()
        ? 'This window is out of date. Reload it, then open the invite link again.'
        : 'This window is out of date. Reload it when you’re ready.',
    );
    return;
  }
  const rawHash = location.hash.slice(1);

  if (rawHash.startsWith('join=')) {
    // Strip the hash first so a reload doesn't re-trigger the join, then
    // run the flow on top of whatever scope renders below.
    history.replaceState(null, '', '/');
    const token = decodeInvite(rawHash.slice(5));
    if (token && isValidShareToken(token)) {
      joinStartedFromLink = true;
      void startJoinFlow(token);
    } else {
      showToast('This invite link doesn’t work anymore. Ask the host for a new one.', 'error');
    }
  }
  const hash = rawHash.startsWith('join=') ? '' : rawHash;

  teardownScreenListeners();
  chatUiTeardown?.();
  chatUiTeardown = null;

  let scope: Scope = PRIVATE_SCOPE;
  if (hash.startsWith('chat/')) {
    const resolved = await coordinator.resolveScope(`chat:${hash.slice(5)}`);
    if (resolved) {
      scope = resolved;
    } else {
      showToast('That chat isn’t on this device');
      history.replaceState(null, '', '/');
    }
  } else if (hash === 'private') {
    // Explicitly the private feed (notification taps) — never scope-restored.
  } else if (!restoredActiveScope && (hash === '' || hash === 'settings')) {
    const resolved = await coordinator.resolveScope(await coordinator.getActiveScopeId());
    if (resolved) scope = resolved;
  }
  restoredActiveScope = true;

  try {
    await coordinator.setActiveScopeId(scopeIdOf(scope));
    if (signedOutElsewhere) return;
    await renderFeed(app, { openSettings: hash === 'settings', scope });
  } catch (err) {
    // Storage refuses this page's writes once another tab has signed out;
    // a route that fails on that is handled just below, not an error.
    if (!signedOutElsewhere) throw err;
  }
  // The sign-out arrived while the feed was being drawn: the feed may have
  // been painted over the sign-in screen — and its listeners left running,
  // if drawing then failed — so put the sign-in screen back.
  if (signedOutElsewhere) {
    showSignedOutElsewhere(app);
    return;
  }
  chatUiTeardown = mountChatUi(app, scopeIdOf(scope));
}

function selectScope(app: HTMLElement, scopeId: ScopeId): void {
  const targetHash = scopeId === 'private' ? '' : `#chat/${scopeId.slice(5)}`;
  const current = location.hash === '#' ? '' : location.hash;
  if (current === targetHash) {
    void route(app);
  } else if (targetHash === '') {
    history.replaceState(null, '', '/');
    void route(app);
  } else {
    location.hash = targetHash;
  }
}

/** Wire the feed title: it opens the chat menu and carries the unread
 *  badge. Re-run per route (the feed re-renders the header). */
function mountChatUi(app: HTMLElement, currentScopeId: ScopeId): () => void {
  const handlers: ChatSwitcherHandlers = {
    onSelect: scopeId => selectScope(app, scopeId),
    onCreate: () => startCreateChatFlow(),
    onManage: chatId =>
      void showManageSheet(chatId, {
        onGoneFromList: () => selectScope(app, 'private'),
      }),
    onReconnect: chatId => startReconnectFlow(chatId),
  };

  const trigger = app.querySelector<HTMLButtonElement>('.feed-title-btn');
  const mount = app.querySelector<HTMLElement>('.chat-menu-mount');
  const badge = app.querySelector<HTMLElement>('.feed-title-badge');
  const menu = trigger && mount ? mountChatMenu(trigger, mount, currentScopeId, handlers) : null;

  const paintBadge = async () => {
    if (!badge) return;
    const chats = await coordinator.loadChats();
    const unread = chats.reduce((sum, chat) => sum + (chat.unreadCount ?? 0), 0);
    badge.hidden = unread === 0;
    // The title button has no aria-label: its content (name, "switch chat",
    // this count) is its accessible name, so a rename or a new count needs no
    // label bookkeeping.
    badge.innerHTML = `${unread > 99 ? '99+' : unread}<span class="visually-hidden"> unread</span>`;
    trigger?.setAttribute('title', unread === 0 ? 'Switch chat' : `Switch chat — ${unread} unread`);
  };
  const repaintBadge = () => void paintBadge().catch(err => console.debug('[Chats] Badge paint failed:', err));
  const offCoordinator = coordinator.onCoordinatorEvent(event => {
    if (event.type === 'chats-changed') repaintBadge();
  });
  const offBroadcast = onBroadcast(event => {
    if (event.type === 'chats-changed') repaintBadge();
  });
  repaintBadge();

  return () => {
    menu?.teardown();
    offCoordinator();
    offBroadcast();
  };
}

/**
 * On resume from background: proactively refresh the access token, land any
 * queued registry writes, and re-check OneDrive for chats created, joined
 * or left on other devices while this one slept. The registry check is a
 * pair of cTag GETs with its own short floor, so it runs on every resume;
 * only the token refresh keeps the longer floor. Coming back online does
 * the same, since a join or leave made offline is waiting to be written.
 *
 * So is a delete made offline: it backs off between tries, and a resume or
 * a reconnect cuts that wait short (see coordinator.retryDeferredDeletes).
 */
function setupResumeHandler(): void {
  let lastRefresh = Date.now();
  const REFRESH_FLOOR_MS = 30_000;

  const catchUp = () => {
    void coordinator.catchUpRegistry(true);
    void coordinator.retryDeferredDeletes();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    catchUp();

    const now = Date.now();
    if (now - lastRefresh < REFRESH_FLOOR_MS) return;
    lastRefresh = now;

    refreshTokenOnResume().catch(() => {
      console.debug('[Auth] Resume token refresh failed — next Graph call will handle it');
    });
  });
  window.addEventListener('online', catchUp);
}

/**
 * Handle incoming Share Target payloads.
 *
 * The service worker answers the share POST by writing the payload
 * (including files) into the milkbox-share IndexedDB and redirecting to
 * /?share=1. We drain the inbox and pre-fill the composer — never
 * auto-send; the user confirms with one tap and can add a caption.
 */
async function handleShareTarget(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const flagged = params.has('share');
  if (flagged) history.replaceState(null, '', '/');

  // A draft a page left for itself across a reload (see reloadKeepingDraft
  // in feed.ts) is only for the account that typed it.
  const accountId = getAccountId();
  const payloads = (await drainShareInbox()).filter(
    payload => !payload.draft || payload.draft.accountId === accountId,
  );
  if (payloads.length === 0) return;

  // Hold SW updates while shared content sits unconfirmed in the composer
  deferSwUpdate = true;

  requestAnimationFrame(() => {
    for (const payload of payloads) applySharePayload(payload);
    // Re-enable SW updates after a grace period — the payload now lives in
    // the composer's DOM state, but give the user a quiet minute first.
    setTimeout(() => {
      deferSwUpdate = false;
      if (pendingSwUpdate) { pendingSwUpdate().catch(() => {}); pendingSwUpdate = null; }
    }, 60_000);
  });
}
