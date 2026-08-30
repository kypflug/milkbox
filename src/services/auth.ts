import {
  PublicClientApplication,
  type Configuration,
  type AccountInfo,
  type AuthenticationResult,
  InteractionRequiredAuthError,
  BrowserAuthError,
} from '@azure/msal-browser';
import { backupMsalCache, clearMsalCacheBackup } from './msal-cache-backup';
import { CLIENT_ID, ACCOUNT_HINT_KEY } from './auth-config';

const REDIRECT_URI = window.location.origin + '/';

const msalConfig: Configuration = {
  auth: {
    clientId: CLIENT_ID,
    authority: 'https://login.microsoftonline.com/consumers',
    redirectUri: REDIRECT_URI,
  },
  cache: {
    cacheLocation: 'localStorage',
  },
};

/**
 * Two consent tiers. Sign-in and all private-feed traffic use BASE_SCOPES —
 * the minimal app-folder grant. Shared chats need whole-drive access
 * (createLink / cross-drive reads live outside the app folder), consented
 * incrementally the first time a user creates or joins a chat; solo users
 * never see the broader prompt.
 */
const BASE_SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read', 'offline_access'];
const SHARE_SCOPES = ['Files.ReadWrite', 'User.Read', 'offline_access'];
/**
 * The share tier's delta over the base tier — passed as extraScopesToConsent
 * on an invited sign-in so a first-time guest consents to everything in the
 * one Microsoft round-trip. No token is minted for it at login; the later
 * silent share-tier acquisition just succeeds without interaction.
 */
const SHARE_CONSENT_SCOPES = ['Files.ReadWrite'];

export type TokenTier = 'base' | 'share';

function scopesFor(tier: TokenTier): string[] {
  return tier === 'share' ? SHARE_SCOPES : BASE_SCOPES;
}

/**
 * Thrown when a share-tier token needs user interaction (never consented,
 * or consent revoked). Share-tier calls run from background polling, so they
 * must never auto-redirect — only an explicit user action converts this into
 * the consent flow.
 */
export class ConsentRequiredError extends Error {
  constructor() {
    super('OneDrive sharing consent required');
  }
}

/** Detect iOS standalone PWA (home-screen installed). */
function isIosStandalone(): boolean {
  const isStandalone =
    ('standalone' in navigator && (navigator as unknown as Record<string, unknown>).standalone === true) ||
    window.matchMedia('(display-mode: standalone)').matches;

  // iPadOS can present a desktop-class UA (Macintosh) in Safari/PWA mode.
  // Treat MacIntel + touch as iPadOS so we still apply iOS-specific auth paths.
  const isClassicIosUa = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isIpadOsDesktopUa = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  if (isStandalone && isIpadOsDesktopUa && !isClassicIosUa) {
    console.debug('[Auth] Detected iPadOS desktop-UA standalone mode');
  }

  return isStandalone && (isClassicIosUa || isIpadOsDesktopUa);
}

let msalInstance: PublicClientApplication | null = null;
let redirectHandled = false;

/**
 * Initialise MSAL and process any redirect response.
 *
 * Returns the AuthenticationResult from `handleRedirectPromise()` if the page
 * is loading after a redirect login — callers (main.ts) should check this to
 * know whether the user just signed in via redirect.
 *
 * On iOS standalone PWA, loginRedirect opens an in-app Safari sheet rather
 * than navigating the page. When the sheet closes, the PWA resumes without
 * reloading. Calling initAuth() again with `force: true` re-processes
 * handleRedirectPromise() to pick up the cached auth response.
 *
 * iOS recovery: iOS kills the WKWebView process aggressively when the PWA is
 * backgrounded. On cold restart, `handleRedirectPromise()` may encounter stale
 * interaction state and clear MSAL's in-memory account cache as a side effect.
 * When that happens and we previously had a signed-in user (account hint in
 * localStorage), we clean up the stale state and re-create the MSAL instance
 * so the second initialisation loads accounts cleanly.
 */
export async function initAuth(force = false): Promise<AuthenticationResult | null> {
  if (!msalInstance) {
    msalInstance = new PublicClientApplication(msalConfig);
    await msalInstance.initialize();
  } else if (redirectHandled && !force) {
    // Already initialised and redirect was processed — nothing to do
    return null;
  }

  // Proactively clean stale interaction state when this page load is NOT
  // returning from a redirect. Stale `interaction.status` keys (left by
  // previous unclean PWA shutdowns or interrupted redirects) cause
  // handleRedirectPromise() to throw, which can clear accounts and force
  // a slow recovery path or full re-login. Cleaning before MSAL sees the
  // stale state prevents the error entirely.
  if (!hasRedirectResponse()) {
    cleanUpStaleState();
  }

  // handleRedirectPromise() MUST be called on every page load.
  // It returns non-null when the page is loading after a loginRedirect / acquireTokenRedirect.
  try {
    const response = await msalInstance.handleRedirectPromise();
    redirectHandled = true;

    // Persist account hint on successful redirect sign-in
    if (response?.account) {
      msalInstance.setActiveAccount(response.account);
      saveAccountHint(response.account);
      // Mirror MSAL cache to IndexedDB (iOS localStorage durability)
      backupMsalCache().catch(() => {});
    }

    return response;
  } catch (err) {
    console.warn('[Auth] handleRedirectPromise failed:', err);
    // Clear any stale interaction state that could block future sign-in attempts
    cleanUpStaleState();

    // After cleanup, re-create MSAL so getAllAccounts() reads cleanly from
    // localStorage without stale interaction entries interfering.
    // This applies to both iOS process-kill recovery and Windows PWA
    // re-opens where stale redirect state causes handleRedirectPromise to throw.
    console.debug('[Auth] Re-creating MSAL instance after stale state cleanup');
    msalInstance = new PublicClientApplication(msalConfig);
    await msalInstance.initialize();
    redirectHandled = true;

    return null;
  }
}

/**
 * Remove stale MSAL interaction/redirect state from localStorage.
 * Failed redirects, interrupted popups, or unclean PWA shutdowns can leave
 * temporary keys behind that cause handleRedirectPromise() to throw on the
 * next page load. We aggressively remove ALL msal-prefixed temporary keys
 * (interaction state, request params/state/nonce/origin, temp cache) rather
 * than only a narrow subset, to prevent recurring cycles.
 */
function cleanUpStaleState(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      // Match all MSAL interaction & temporary redirect keys
      if (
        key.includes('interaction.status') ||
        key.includes('request.params') ||
        key.includes('request.state') ||
        key.includes('request.nonce') ||
        key.includes('request.origin') ||
        key.includes('request.authority') ||
        key.includes('request.correlationId') ||
        // Temp cache entries from failed redirects
        (key.startsWith('msal.') && key.includes('.temp.'))
      ) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    if (keysToRemove.length > 0) {
      console.debug('[Auth] Cleared stale MSAL state:', keysToRemove);
    }
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Detect whether this page load is returning from a MSAL login/token redirect.
 * MSAL redirect responses include `code`, `error`, `id_token`, or `access_token`
 * in the URL hash or query. Our app's own routes (#settings, #chat/<ULID>) and
 * the share target (?share=1) never contain these parameters — and the invite
 * deep link is exactly `#join=` + unpadded base64url ([A-Za-z0-9_-]), an
 * alphabet with no `=`, so none of the substrings above can occur. Raw share
 * URLs (which carry arbitrary query strings) must never be put in the hash.
 */
function hasRedirectResponse(): boolean {
  const hash = window.location.hash;
  if (hash.includes('code=') || hash.includes('error=') || hash.includes('id_token=') || hash.includes('access_token=')) {
    return true;
  }
  const search = window.location.search;
  return search.includes('code=');
}

/** Get the MSAL instance, assuming initAuth() has been called. */
function getMsal(): PublicClientApplication {
  if (!msalInstance) throw new Error('MSAL not initialised — call initAuth() first');
  return msalInstance;
}

export function getAccount(): AccountInfo | null {
  if (!msalInstance) return null;
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    if (!msalInstance.getActiveAccount()) msalInstance.setActiveAccount(accounts[0]);
    saveAccountHint(accounts[0]);
    return accounts[0];
  }
  return null;
}

/**
 * Sign the user in via redirect.
 *
 * Uses loginRedirect on all platforms — it's the most reliable auth flow
 * for PWAs. The page navigates to Microsoft login, then back to the app.
 * On return, handleRedirectPromise() in initAuth() processes the response.
 *
 * preConsentShare folds the shared-chats consent into this sign-in (an
 * invited first-time guest joins in one round-trip); sign-in itself still
 * requests only the base scopes, so solo sign-ins are unchanged.
 *
 * Returns null since the page navigates away — callers should not proceed.
 */
export async function signIn(opts: { preConsentShare?: boolean } = {}): Promise<AccountInfo | null> {
  const msal = getMsal();
  await msal.loginRedirect({
    scopes: BASE_SCOPES,
    prompt: 'select_account',
    ...(opts.preConsentShare ? { extraScopesToConsent: SHARE_CONSENT_SCOPES } : {}),
  });
  // loginRedirect navigates away; this code won't continue.
  return null;
}

/**
 * Sign the user out via redirect.
 */
export async function signOut(): Promise<void> {
  const msal = getMsal();
  const account = getAccount();
  if (!account) return;

  clearAccountHint();
  clearMsalCacheBackup().catch(() => {});

  await msal.logoutRedirect({
    account,
    postLogoutRedirectUri: REDIRECT_URI,
  });
  // Page navigates away
}

export async function getAccessToken(tier: TokenTier = 'base'): Promise<string> {
  const msal = getMsal();
  const account = getAccount();
  if (!account) throw new Error('Not signed in');
  const scopes = scopesFor(tier);

  /**
   * Interactive fallback when silent acquisition is exhausted. Base tier
   * redirects with the scopes that actually failed (redirecting with a
   * different set would consent the wrong scopes and loop). Share tier never
   * auto-redirects — see ConsentRequiredError.
   */
  const interactive = async (): Promise<never> => {
    if (tier === 'share') throw new ConsentRequiredError();
    await msal.acquireTokenRedirect({ scopes, account });
    throw new Error('Redirecting for token…');
  };

  try {
    const result = await msal.acquireTokenSilent({ scopes, account });
    if (!result.accessToken) {
      throw new InteractionRequiredAuthError('empty_token', 'Silent token acquisition returned empty access token');
    }
    // Keep IndexedDB backup fresh after every successful token acquisition
    backupMsalCache().catch(() => {});
    return result.accessToken;
  } catch (err) {
    // In PWA standalone/WCO mode, iframe-based silent renewal often fails
    // with BrowserAuthError (block_iframe_reload, timed_out). Retry using
    // the refresh token (forceRefresh bypasses the iframe approach).
    if (err instanceof BrowserAuthError) {
      console.debug('[Auth] Silent iframe renewal failed, retrying with refresh token:', (err as Error).message);
      try {
        const result = await msal.acquireTokenSilent({ scopes, account, forceRefresh: true });
        if (result.accessToken) {
          backupMsalCache().catch(() => {});
          return result.accessToken;
        }
      } catch (retryErr) {
        console.warn('[Auth] Refresh token retry also failed:', retryErr);
        return interactive();
      }
    }

    if (err instanceof InteractionRequiredAuthError) {
      console.debug('[Auth] InteractionRequiredAuthError on %s tier', tier);
      return interactive();
    }
    throw err;
  }
}

/**
 * Whether the share tier can mint a token without interaction — used by the
 * UI to skip the consent interstitial for already-consented users.
 */
export async function hasShareConsent(): Promise<boolean> {
  if (!msalInstance) return false;
  const account = getAccount();
  if (!account) return false;
  try {
    const result = await msalInstance.acquireTokenSilent({ scopes: scopesFor('share'), account });
    return Boolean(result.accessToken);
  } catch {
    return false;
  }
}

/**
 * Start the interactive consent round-trip for the share tier. The caller
 * must have persisted a pending action first (the redirect navigates away on
 * desktop; on iOS standalone it opens the in-app sheet instead — callers pair
 * this with the one-shot visibilitychange → initAuth(true) recovery pattern).
 */
export async function requestShareConsent(): Promise<void> {
  const msal = getMsal();
  const account = getAccount();
  if (!account) throw new Error('Not signed in');
  await msal.acquireTokenRedirect({ scopes: scopesFor('share'), account });
}

export function isSignedIn(): boolean {
  return getAccount() !== null;
}

export function getUserDisplayName(): string {
  const account = getAccount();
  return account?.name || account?.username || '';
}

export function getUserEmail(): string {
  return getAccount()?.username || '';
}

// ─── Account hint (iOS process-kill recovery) ───

/** Persist a lightweight marker so we know a user was previously signed in. */
function saveAccountHint(account: AccountInfo): void {
  try {
    localStorage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({
      username: account.username,
      name: account.name,
      homeAccountId: account.homeAccountId,
    }));
  } catch { /* localStorage may be unavailable */ }
}

/** Returns true if we previously had a signed-in user. */
export function hasAccountHint(): boolean {
  try {
    return localStorage.getItem(ACCOUNT_HINT_KEY) !== null;
  } catch {
    return false;
  }
}

/** Clear the account hint (on explicit sign-out). */
function clearAccountHint(): void {
  try {
    localStorage.removeItem(ACCOUNT_HINT_KEY);
  } catch { /* */ }
}

/** Read the saved account hint (username + homeAccountId). */
function getAccountHint(): { username: string; homeAccountId: string } | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_HINT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── iOS resume recovery ───

/**
 * Attempt to silently recover auth state after an iOS cold restart wiped
 * localStorage. Called from the boot path in main.ts when `isSignedIn()`
 * returns false but we know the user was previously signed in (account hint
 * was restored from IndexedDB along with the MSAL cache).
 *
 * Strategy:
 * 1. If MSAL has accounts after the IndexedDB restore, try acquireTokenSilent
 *    with forceRefresh (uses refresh token, no iframe).
 * 2. If that fails, try ssoSilent with the saved loginHint — this uses a
 *    hidden iframe and may work if the user has an active Microsoft session.
 * 3. If all else fails, return false and the caller shows the sign-in screen.
 *
 * Returns true if auth was recovered successfully.
 */
export async function tryRecoverAuth(): Promise<boolean> {
  if (!msalInstance) return false;

  // Step 1: check if MSAL found accounts after cache restore
  const account = getAccount();
  if (account) {
    try {
      const result = await msalInstance.acquireTokenSilent({
        scopes: BASE_SCOPES,
        account,
        forceRefresh: true,
      });
      if (result.accessToken) {
        console.info('[Auth] Recovery: silent token refresh succeeded');
        backupMsalCache().catch(() => {});
        return true;
      }
    } catch (err) {
      console.debug('[Auth] Recovery: acquireTokenSilent failed:', (err as Error).message);
    }
  }

  // Step 2: try ssoSilent with login hint from account hint.
  // Skip when:
  //  - iOS standalone PWA (hidden iframes blocked by third-party cookie restrictions)
  //  - No MSAL accounts at all (ssoSilent requires functioning third-party cookies,
  //    which are increasingly blocked in Edge/Chrome; when it fails it wastes 3-6s
  //    on the timeout — the caller should auto-redirect with loginHint instead)
  if (!account) {
    console.debug('[Auth] No MSAL accounts — skipping ssoSilent, caller should redirect');
    return false;
  }

  if (!isIosStandalone()) {
    const hint = getAccountHint();
    if (hint?.username) {
      try {
        const result = await msalInstance.ssoSilent({
          scopes: BASE_SCOPES,
          loginHint: hint.username,
        });
        if (result.account) {
          saveAccountHint(result.account);
          backupMsalCache().catch(() => {});
          console.info('[Auth] Recovery: ssoSilent succeeded');
          return true;
        }
      } catch (err) {
        console.debug('[Auth] Recovery: ssoSilent failed:', (err as Error).message);
      }
    }
  } else {
    console.debug('[Auth] iOS standalone detected — skipping ssoSilent (iframe blocked)');
  }

  return false;
}

/**
 * Proactively refresh the access token when the app resumes from background.
 * Called on visibilitychange → visible.
 *
 * Try non-forced silent first (cheap — returns cached token if still valid).
 * Only escalate to forceRefresh if that fails. Always-forceRefresh is
 * unnecessarily expensive and can trigger rate limits.
 */
export async function refreshTokenOnResume(): Promise<void> {
  if (!msalInstance) return;
  const account = getAccount();
  if (!account) return;

  try {
    // Step 1: cheap silent acquire (uses cached token if still valid)
    const result = await msalInstance.acquireTokenSilent({
      scopes: BASE_SCOPES,
      account,
    });
    if (result.accessToken) {
      return;
    }
  } catch {
    // Cached token is stale/expired — escalate to forceRefresh
  }

  try {
    // Step 2: force refresh via refresh token (no iframe)
    await msalInstance.acquireTokenSilent({
      scopes: BASE_SCOPES,
      account,
      forceRefresh: true,
    });
    backupMsalCache().catch(() => {});
    console.debug('[Auth] Resume: token refreshed via refresh token');
  } catch {
    // Not critical — the next getAccessToken() call will handle refresh
    console.debug('[Auth] Resume: token refresh failed — will recover on next Graph call');
  }
}

/**
 * Perform a loginRedirect pre-filled with the saved account hint.
 * Used for seamless re-authentication when silent recovery fails but the
 * user's Microsoft session is likely still active.
 *
 * Omits `prompt: 'select_account'` so Microsoft can auto-sign-in with
 * the hinted account if only one session is active.
 */
export async function signInWithHint(): Promise<void> {
  const msal = getMsal();
  const hint = getAccountHint();
  // Deliberately never preConsentShare here: auto-redirect skips the invited
  // sign-in sheet, so the user would face the full-drive consent without ever
  // seeing the disclosure. The in-app interstitial covers that path instead.
  await msal.loginRedirect({
    scopes: BASE_SCOPES,
    ...(hint?.username ? { loginHint: hint.username } : {}),
  });
}
