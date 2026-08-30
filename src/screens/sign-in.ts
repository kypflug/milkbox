import { signIn } from '../services/auth';
import { showToast } from '../components/toast';
import { iconBottle } from '../components/icons';

/**
 * Sign-in screen — the doorstep. One sheet, one button. The invited variant
 * greets someone who arrived through a chat invite link.
 */
export function renderSignIn(
  app: HTMLElement,
  _onSignedIn: () => void,
  opts: { invited?: boolean } = {},
): void {
  const dek = opts.invited
    ? 'You’ve been invited to a Milkbox chat. Sign in to join.'
    : 'A chat with yourself. Drop text, links, and files here; they land on every device.';
  // The invited sign-in folds the shared-chats consent into the one Microsoft
  // round-trip, so the transparency the consent interstitial normally provides
  // has to live here, before Microsoft's prompt.
  const fine = opts.invited
    ? 'Chats live in a folder in the host’s OneDrive, so Microsoft will ask you to let Milkbox access your OneDrive files. Your private drops stay in a private app folder of your own.'
    : 'Your private drops live in your own OneDrive, in a private app folder. Shared chats live in their host’s OneDrive.';
  app.innerHTML = `
    <div class="sign-in-screen">
      <div class="boot-titlebar" aria-hidden="true"></div>
      <div class="sign-in-sheet">
        <div class="sign-in-glyph">${iconBottle('44px')}</div>
        <h1 class="sign-in-title">Milkbox</h1>
        <p class="sign-in-dek">${dek}</p>
        <button class="sign-in-button" id="signInBtn">Sign in with Microsoft</button>
        <p class="sign-in-fine">${fine}</p>
      </div>
    </div>
  `;

  document.getElementById('signInBtn')!.addEventListener('click', async () => {
    try {
      await signIn({ preConsentShare: opts.invited });
      // loginRedirect navigates away; if we're still here something failed.
    } catch (err) {
      console.error('Sign-in failed:', err);
      showToast('Sign-in failed. Please try again.', 'error');
    }
  });
}
