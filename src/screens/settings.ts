import { getUserDisplayName, getUserEmail, signOut } from '../services/auth';
import { getDeviceName } from '../services/device';
import { getTheme, applyTheme } from '../theme';
import { clearAllData } from '../services/db';
import { escapeHtml } from '../utils/storage';
import { showToast } from '../components/toast';
import { iconClose } from '../components/icons';
import { renameCurrentDevice } from '../services/sync-coordinator';
import type { Theme } from '../types';

export interface SettingsFlyoutApi {
  open(): void;
  close(): void;
  toggle(): void;
  teardown(): void;
}

export function mountSettingsFlyout(
  container: HTMLElement,
  trigger: HTMLButtonElement,
  titleRegion: HTMLElement,
): SettingsFlyoutApi {
  const themes: Theme[] = ['system', 'light', 'dark'];
  container.innerHTML = `
    <section class="settings-flyout" id="settingsFlyout" role="dialog"
             aria-labelledby="settingsTitle" hidden>
      <header class="settings-header">
        <h2 class="settings-title" id="settingsTitle">Settings</h2>
        <button class="settings-close" title="Close" aria-label="Close settings">${iconClose('1.2em')}</button>
      </header>
      <div class="settings-body">
        <section class="settings-section">
          <h3 class="settings-label">Account</h3>
          <p class="settings-account">
            <span class="settings-account-name">${escapeHtml(getUserDisplayName())}</span>
            <span class="settings-account-email">${escapeHtml(getUserEmail())}</span>
          </p>
          <button class="settings-button settings-button-danger" data-settings-action="sign-out">Sign out</button>
        </section>

        <section class="settings-section">
          <h3 class="settings-label">This device</h3>
          <p class="settings-hint">Shown on drops you send from here.</p>
          <input class="settings-input" type="text" maxlength="40"
                 value="${escapeHtml(getDeviceName())}" aria-label="Device name">
        </section>

        <section class="settings-section">
          <h3 class="settings-label">Theme</h3>
          <div class="settings-segment" role="radiogroup" aria-label="Theme">
            ${themes
              .map(
                theme => `
              <button class="settings-segment-option${getTheme() === theme ? ' selected' : ''}"
                      role="radio" aria-checked="${getTheme() === theme}"
                      data-theme-option="${theme}">
                ${theme[0].toUpperCase() + theme.slice(1)}
              </button>`,
              )
              .join('')}
          </div>
        </section>

        <section class="settings-section">
          <h3 class="settings-label">About</h3>
          <p class="settings-hint">
            Drops are stored in your OneDrive under <span class="settings-mono">Apps/Milkbox</span>.
            Delete the folder there and everything is gone — this app keeps no other copy.
          </p>
        </section>
      </div>
    </section>
  `;

  const panel = container.querySelector<HTMLElement>('.settings-flyout')!;
  const closeButton = panel.querySelector<HTMLButtonElement>('.settings-close')!;
  const deviceInput = panel.querySelector<HTMLInputElement>('.settings-input')!;
  const resizeObserver = new ResizeObserver(() => {
    if (!panel.hidden) positionPanel();
  });

  trigger.setAttribute('aria-controls', panel.id);
  trigger.setAttribute('aria-expanded', 'false');

  function positionPanel(): void {
    const containerRect = container.getBoundingClientRect();
    const titleRect = titleRegion.getBoundingClientRect();
    const gap = 12;
    const availableHeight = Math.max(0, containerRect.top - titleRect.bottom - gap);
    panel.style.maxHeight = `${availableHeight}px`;
  }

  function open(): void {
    if (!panel.hidden && !panel.classList.contains('closing')) return;
    panel.classList.remove('closing');
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionPanel();
    closeButton.focus();
  }

  function close(): void {
    if (panel.hidden || panel.classList.contains('closing')) return;
    panel.classList.add('closing');
    trigger.setAttribute('aria-expanded', 'false');
    if (location.hash === '#settings') {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
    trigger.focus();
  }

  function toggle(): void {
    if (panel.hidden) open();
    else close();
  }

  const onDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || panel.hidden) return;
    if (!panel.contains(target) && !trigger.contains(target)) close();
  };
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (panel.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  const onWindowResize = () => {
    if (!panel.hidden) positionPanel();
  };
  const onPanelAnimationEnd = (event: AnimationEvent) => {
    if (event.animationName !== 'settings-flyout-out') return;
    panel.hidden = true;
    panel.classList.remove('closing');
  };

  trigger.addEventListener('click', toggle);
  closeButton.addEventListener('click', () => close());
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
  window.addEventListener('resize', onWindowResize);
  panel.addEventListener('animationend', onPanelAnimationEnd);
  resizeObserver.observe(container);

  panel.querySelector<HTMLButtonElement>('[data-settings-action="sign-out"]')!
    .addEventListener('click', async () => {
      try {
        await clearAllData();
      } catch (err) {
        console.warn('Failed to clear local data during sign-out:', err);
      }
      await signOut();
    });

  deviceInput.addEventListener('change', async () => {
    await renameCurrentDevice(deviceInput.value);
    deviceInput.value = getDeviceName();
    showToast('Device name saved');
  });

  panel.querySelectorAll<HTMLButtonElement>('[data-theme-option]').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.themeOption as Theme;
      applyTheme(theme);
      panel.querySelectorAll<HTMLButtonElement>('[data-theme-option]').forEach(option => {
        const selected = option === btn;
        option.classList.toggle('selected', selected);
        option.setAttribute('aria-checked', String(selected));
      });
      positionPanel();
    });
  });

  return {
    open,
    close: () => close(),
    toggle,
    teardown() {
      resizeObserver.disconnect();
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
      window.removeEventListener('resize', onWindowResize);
      panel.removeEventListener('animationend', onPanelAnimationEnd);
    },
  };
}
