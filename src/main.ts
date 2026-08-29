import { initAuth, isSignedIn, tryRecoverAuth, refreshTokenOnResume, hasAccountHint, signInWithHint } from './services/auth';
import { restoreMsalCacheIfNeeded, setupBackgroundBackup } from './services/msal-cache-backup';
import { initBroadcast, postBroadcast } from './services/broadcast';
import { drainShareInbox } from './services/share-inbox';
import * as coordinator from './services/sync-coordinator';
import { resumePendingAction, startCreateChatFlow, startJoinFlow, startReconnectFlow } from './services/chat-flows';
import { setPendingAction } from './services/pending-actions';
import { renderSignIn } from './screens/sign-in';
import { renderFeed, applySharePayload, teardownScreenListeners } from './screens/feed';
import { showManageSheet } from './screens/chat-sheets';
import { mountChatSwitcher } from './components/chat-switcher';
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
    if (errMsg.includes('localstorage') || errMsg.includes('quota') || errMsg.includes('storage')) {
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

async function boot(app: HTMLElement): Promise<void> {
  applyTheme();
  trackWindowControlsSide();

  // Restore MSAL cache from IndexedDB if iOS wiped localStorage
  const cacheRestored = await restoreMsalCacheIfNeeded();
  if (cacheRestored) {
    console.info('[Boot] MSAL cache restored from IndexedDB backup');
  }

  // initAuth() returns a non-null AuthenticationResult when this page load
  // is the result of a loginRedirect completing.
  const redirectResponse = await initAuth();

  // Auth redirect handling is done — safe to activate pending SW update
  authBootComplete = true;
  if (pendingSwUpdate && !deferSwUpdate) {
    pendingSwUpdate().catch(() => {});
    pendingSwUpdate = null;
  }

  // An invite link opened while signed out: park the join (IDB — survives
  // the sign-in redirect and iOS storage wipes) and greet as invited.
  const invitedToken = location.hash.startsWith('#join=')
    ? decodeURIComponent(location.hash.slice(6))
    : null;
  const signedIn = Boolean(redirectResponse?.account) || isSignedIn();
  if (invitedToken && !signedIn) {
    invitedSignIn = true;
    await setPendingAction({ type: 'join', token: invitedToken, createdAt: Date.now() });
    history.replaceState(null, '', '/');
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
    await signInWithHint();
  } catch {
    document.removeEventListener('visibilitychange', handler);
    renderSignIn(app, () => void enterApp(app), { invited: invitedSignIn });
  }
}

/** Transition to the main app: routing, share target, and resume handler. */
async function enterApp(app: HTMLElement): Promise<void> {
  initBroadcast();
  postBroadcast({ type: 'auth-changed', signedIn: true });
  await route(app);
  window.addEventListener('hashchange', () => void route(app));
  // Anything a consent redirect / sign-in / iOS sheet interrupted.
  await resumePendingAction();
  await handleShareTarget();
  setupResumeHandler();
  setupBackgroundBackup();
  // Warm the author identity and pull chats this account has elsewhere
  // (hosted folders + roaming pointers) into the local registry.
  void coordinator.ensureMe();
  void coordinator.hydrateChatRegistry();

  if (import.meta.env.DEV) {
    const dev = await import('./dev/chat-dev');
    dev.installChatDevHarness();
  }
}

/** Only the very first empty-hash route restores the remembered scope —
 *  after that, an empty hash means the user chose the private feed. */
let restoredActiveScope = false;
let chatUiTeardown: (() => void) | null = null;

async function route(app: HTMLElement): Promise<void> {
  const rawHash = location.hash.slice(1);

  if (rawHash.startsWith('join=')) {
    // Strip the hash first so a reload doesn't re-trigger the join, then
    // run the flow on top of whatever scope renders below.
    history.replaceState(null, '', '/');
    void startJoinFlow(decodeURIComponent(rawHash.slice(5)));
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
  } else if (!restoredActiveScope && (hash === '' || hash === 'settings')) {
    const resolved = await coordinator.resolveScope(await coordinator.getActiveScopeId());
    if (resolved) scope = resolved;
  }
  restoredActiveScope = true;

  await coordinator.setActiveScopeId(scopeIdOf(scope));
  await renderFeed(app, { openSettings: hash === 'settings', scope });
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

/** Mount the chat switcher beside the freshly rendered feed and wire its trigger. */
function mountChatUi(app: HTMLElement, currentScopeId: ScopeId): () => void {
  const switcher = mountChatSwitcher(app, currentScopeId, {
    onSelect: scopeId => selectScope(app, scopeId),
    onCreate: () => startCreateChatFlow(),
    onManage: chatId =>
      void showManageSheet(chatId, {
        onGoneFromList: () => selectScope(app, 'private'),
      }),
    onReconnect: chatId => startReconnectFlow(chatId),
  });
  const trigger = app.querySelector<HTMLButtonElement>('.composer-chats');
  const onTrigger = () => switcher.toggle();
  trigger?.addEventListener('click', onTrigger);
  return () => {
    trigger?.removeEventListener('click', onTrigger);
    switcher.teardown();
  };
}

/**
 * Proactively refresh the access token when the app resumes from background,
 * with a hard floor between attempts.
 */
function setupResumeHandler(): void {
  let lastRefresh = Date.now();
  const REFRESH_FLOOR_MS = 30_000;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    const now = Date.now();
    if (now - lastRefresh < REFRESH_FLOOR_MS) return;
    lastRefresh = now;

    refreshTokenOnResume().catch(() => {
      console.debug('[Auth] Resume token refresh failed — next Graph call will handle it');
    });
  });
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

  const payloads = await drainShareInbox();
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
