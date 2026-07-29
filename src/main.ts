import { initAuth, isSignedIn, tryRecoverAuth, refreshTokenOnResume, hasAccountHint, signInWithHint } from './services/auth';
import { restoreMsalCacheIfNeeded, setupBackgroundBackup } from './services/msal-cache-backup';
import { initBroadcast, postBroadcast } from './services/broadcast';
import { drainShareInbox } from './services/share-inbox';
import { renderSignIn } from './screens/sign-in';
import { renderFeed, applySharePayload, teardownScreenListeners } from './screens/feed';
import { renderSettings } from './screens/settings';
import { applyTheme } from './theme';
import { escapeHtml } from './utils/storage';
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

  if (redirectResponse?.account || isSignedIn()) {
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
      renderSignIn(app, () => void enterApp(app));
    }
  } else {
    renderSignIn(app, () => void enterApp(app));
  }
}

// ─── Auto-redirect helpers (iOS session recovery) ───

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

    renderSignIn(app, () => void enterApp(app));
  };
  document.addEventListener('visibilitychange', handler);

  try {
    await signInWithHint();
  } catch {
    document.removeEventListener('visibilitychange', handler);
    renderSignIn(app, () => void enterApp(app));
  }
}

/** Transition to the main app: routing, share target, and resume handler. */
async function enterApp(app: HTMLElement): Promise<void> {
  initBroadcast();
  postBroadcast({ type: 'auth-changed', signedIn: true });
  await route(app);
  window.addEventListener('hashchange', () => void route(app));
  await handleShareTarget();
  setupResumeHandler();
  setupBackgroundBackup();
}

async function route(app: HTMLElement): Promise<void> {
  teardownScreenListeners();
  const hash = location.hash.slice(1);
  if (hash === 'settings') {
    renderSettings(app);
  } else {
    await renderFeed(app);
  }
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
