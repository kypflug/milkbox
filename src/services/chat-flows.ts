/**
 * The user-facing chat flows: create, join, and the incremental-consent
 * round-trip they share. This module owns converting ConsentRequiredError
 * into the interstitial → redirect → resume dance; the sheets are dumb UI.
 *
 * iOS standalone: acquireTokenRedirect opens an in-app Safari sheet without
 * navigating the page, so beginShareConsent arms a one-shot visibilitychange
 * listener that re-processes auth (initAuth(true)) and resumes — the same
 * pattern main.ts uses for sign-in recovery. On desktop the page navigates
 * away and boot() → enterApp() → resumePendingAction() picks the record up.
 */

import { ConsentRequiredError, hasShareConsent, initAuth, requestShareConsent } from './auth';
import { GraphHttpError } from './graph';
import * as coordinator from './sync-coordinator';
import { clearPendingAction, getPendingAction, setPendingAction, type PendingAction } from './pending-actions';
import { showConsentInterstitial, showCreateChatSheet, showInviteSheet, showJoinProgress } from '../screens/chat-sheets';
import { showToast } from '../components/toast';

const CONSENT_DENIED_COPY = 'Milkbox needs OneDrive access for shared chats. You can try again anytime.';

/** Failure copy that names the OneDrive status — a report of "error 400"
 *  diagnoses itself, where a generic connection hint cannot. */
function describeFailure(prefix: string, err: unknown): string {
  if (err instanceof GraphHttpError) return `${prefix} — OneDrive error ${err.status}. Try again.`;
  return `${prefix}. Check your connection and try again.`;
}

function openChat(chatId: string): void {
  location.hash = `#chat/${chatId}`;
}

async function beginShareConsent(action: PendingAction): Promise<void> {
  await setPendingAction({ ...action, consentRequested: true });

  // iOS in-app sheet recovery — on desktop the redirect fires first and this
  // listener never runs.
  const onVisible = async () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVisible);
    try {
      await initAuth(true);
    } catch { /* resume probes consent below either way */ }
    void resumePendingAction();
  };
  document.addEventListener('visibilitychange', onVisible);

  try {
    await requestShareConsent();
  } catch (err) {
    document.removeEventListener('visibilitychange', onVisible);
    console.warn('[Chats] Consent redirect failed:', err);
    await clearPendingAction();
    showToast('Couldn’t open Microsoft sign-in. Try again.', 'error');
  }
}

/** Run an action that already holds share consent. */
async function execute(action: PendingAction): Promise<void> {
  await clearPendingAction();
  if (action.type === 'create-chat') {
    await doCreate(action.name);
  } else if (action.type === 'join') {
    await doJoin(action.token);
  } else {
    await coordinator.reactivateChat(action.chatId);
    showToast('Shared chats reconnected');
  }
}

async function doCreate(name: string): Promise<void> {
  showToast('Creating chat…');
  try {
    const record = await coordinator.createChat(name);
    openChat(record.id);
    // Hand the host the invite immediately — a chat with no invite is inert.
    void showInviteSheet(record.id);
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      // The share grant isn't actually there (revoked, or a stale probe) —
      // restart the consent round-trip instead of dead-ending on a toast.
      showConsentInterstitial(() => {
        void beginShareConsent({ type: 'create-chat', name, createdAt: Date.now() });
      });
      return;
    }
    console.warn('[Chats] Create failed:', err);
    showToast(describeFailure('Couldn’t create the chat', err), 'error');
  }
}

async function doJoin(token: string): Promise<void> {
  const progress = showJoinProgress();
  try {
    const record = await coordinator.joinChat(token);
    progress.close();
    openChat(record.id);
    showToast(`You joined ${record.name}`);
  } catch (err) {
    if (err instanceof coordinator.JoinError) {
      progress.fail(
        'This invite link doesn’t work anymore.',
        err.reason === 'not-a-chat'
          ? 'The link opened a shared folder, but it isn’t a Milkbox chat.'
          : 'It may have been reset or the chat deleted. Ask the host for a new link.',
      );
      return;
    }
    console.warn('[Chats] Join failed:', err);
    // Network-shaped failure: keep the pending record so the join resumes
    // on the next launch, and offer an immediate retry.
    await setPendingAction({ type: 'join', token, createdAt: Date.now() });
    progress.fail(
      'Couldn’t reach the chat.',
      'You may be offline — we’ll finish joining when you’re back. You can also try again now.',
      () => void startJoinFlow(token),
    );
  }
}

/** Entry point from the switcher's "New chat". */
export function startCreateChatFlow(): void {
  showCreateChatSheet(name => {
    void (async () => {
      if (await hasShareConsent()) {
        await doCreate(name);
      } else {
        showConsentInterstitial(() => {
          void beginShareConsent({ type: 'create-chat', name, createdAt: Date.now() });
        });
      }
    })();
  });
}

/** Entry point from a #join= deep link (signed in). */
export async function startJoinFlow(token: string): Promise<void> {
  await setPendingAction({ type: 'join', token, createdAt: Date.now() });
  if (await hasShareConsent()) {
    await clearPendingAction();
    await doJoin(token);
  } else {
    showConsentInterstitial(() => {
      void beginShareConsent({ type: 'join', token, createdAt: Date.now() });
    });
  }
}

/** Entry point from a needs-consent chat row. */
export function startReconnectFlow(chatId: string): void {
  void (async () => {
    if (await hasShareConsent()) {
      await coordinator.reactivateChat(chatId);
      return;
    }
    showConsentInterstitial(() => {
      void beginShareConsent({ type: 'reconnect', chatId, createdAt: Date.now() });
    });
  })();
}

/**
 * Pick up whatever a redirect, sheet, or sign-in interrupted. Called from
 * enterApp() on every boot and from the iOS sheet-recovery listener.
 */
export async function resumePendingAction(): Promise<void> {
  const action = await getPendingAction();
  if (!action) return;

  if (await hasShareConsent()) {
    await execute(action);
    return;
  }

  if (action.consentRequested) {
    // We asked, we came back, and the grant still isn't there — denial.
    await clearPendingAction();
    showToast(CONSENT_DENIED_COPY, 'error');
    return;
  }

  // Not asked yet (e.g. the join was parked while signed out) — ask now.
  showConsentInterstitial(() => {
    void beginShareConsent(action);
  });
}
