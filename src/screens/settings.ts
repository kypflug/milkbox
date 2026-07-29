import { getUserDisplayName, getUserEmail, signOut } from '../services/auth';
import { getDeviceName, setDeviceName } from '../services/device';
import { getTheme, applyTheme } from '../theme';
import { clearAllData } from '../services/db';
import { escapeHtml } from '../utils/storage';
import { showToast } from '../components/toast';
import type { Theme } from '../types';

export function renderSettings(app: HTMLElement): void {
  const themes: Theme[] = ['system', 'light', 'dark'];
  app.innerHTML = `
    <div class="settings-screen">
      <div class="boot-titlebar" aria-hidden="true"></div>
      <header class="settings-header">
        <a class="settings-back" href="#" aria-label="Back to feed">← Feed</a>
        <h1 class="settings-title">Settings</h1>
      </header>
      <div class="settings-body">
        <section class="settings-section">
          <h2 class="settings-label">Account</h2>
          <p class="settings-account">
            <span class="settings-account-name">${escapeHtml(getUserDisplayName())}</span>
            <span class="settings-account-email">${escapeHtml(getUserEmail())}</span>
          </p>
          <button class="settings-button settings-button-danger" id="signOutBtn">Sign out</button>
        </section>

        <section class="settings-section">
          <h2 class="settings-label">This device</h2>
          <p class="settings-hint">Shown on drops you send from here.</p>
          <input class="settings-input" id="deviceNameInput" type="text" maxlength="40"
                 value="${escapeHtml(getDeviceName())}" aria-label="Device name">
        </section>

        <section class="settings-section">
          <h2 class="settings-label">Theme</h2>
          <div class="settings-segment" role="radiogroup" aria-label="Theme">
            ${themes
              .map(
                t => `
              <button class="settings-segment-option${getTheme() === t ? ' selected' : ''}"
                      role="radio" aria-checked="${getTheme() === t}" data-theme-option="${t}">
                ${t[0].toUpperCase() + t.slice(1)}
              </button>`,
              )
              .join('')}
          </div>
        </section>

        <section class="settings-section">
          <h2 class="settings-label">About</h2>
          <p class="settings-hint">
            Drops are stored in your OneDrive under <span class="settings-mono">Apps/Milkbox</span>.
            Delete the folder there and everything is gone — this app keeps no other copy.
          </p>
        </section>
      </div>
    </div>
  `;

  document.getElementById('signOutBtn')!.addEventListener('click', async () => {
    try {
      await clearAllData();
    } catch { /* best-effort */ }
    await signOut();
  });

  const deviceInput = document.getElementById('deviceNameInput') as HTMLInputElement;
  deviceInput.addEventListener('change', () => {
    setDeviceName(deviceInput.value);
    showToast('Device name saved');
  });

  app.querySelectorAll<HTMLButtonElement>('[data-theme-option]').forEach(btn => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.themeOption as Theme;
      applyTheme(theme);
      app.querySelectorAll<HTMLButtonElement>('[data-theme-option]').forEach(b => {
        const selected = b === btn;
        b.classList.toggle('selected', selected);
        b.setAttribute('aria-checked', String(selected));
      });
    });
  });
}
