import { signIn } from '../services/auth';
import { showToast } from '../components/toast';
import { iconBottle } from '../components/icons';

/**
 * Sign-in screen — the doorstep. One sheet, one button.
 */
export function renderSignIn(app: HTMLElement, _onSignedIn: () => void): void {
  app.innerHTML = `
    <div class="sign-in-screen">
      <div class="boot-titlebar" aria-hidden="true"></div>
      <div class="sign-in-sheet">
        <div class="sign-in-glyph">${iconBottle('44px')}</div>
        <h1 class="sign-in-title">Milkbox</h1>
        <p class="sign-in-dek">A chat with yourself. Drop text, links, and files here; they land on every device.</p>
        <button class="sign-in-button" id="signInBtn">Sign in with Microsoft</button>
        <p class="sign-in-fine">Your drops live in your own OneDrive, in a private app folder. Nothing is stored anywhere else.</p>
      </div>
    </div>
  `;

  document.getElementById('signInBtn')!.addEventListener('click', async () => {
    try {
      await signIn();
      // loginRedirect navigates away; if we're still here something failed.
    } catch (err) {
      console.error('Sign-in failed:', err);
      showToast('Sign-in failed. Please try again.', 'error');
    }
  });
}
