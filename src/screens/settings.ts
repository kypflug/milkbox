import { getUserDisplayName, getUserEmail, signOut } from '../services/auth';
import { getDeviceName } from '../services/device';
import { getTheme, applyTheme } from '../theme';
import { escapeAttr, escapeHtml } from '../utils/storage';
import { showToast } from '../components/toast';
import { iconClose } from '../components/icons';
import { renameCurrentDevice, resetScope, shutdown, wipeForSignOut } from '../services/sync-coordinator';
import { getDiagnostics, type Diagnostics, type PassStats } from '../services/sync-stats';
import { postBroadcast } from '../services/broadcast';
import {
  isNotifySupported,
  isNotifyEnabled,
  getNotifyPermission,
  setNotifyEnabled,
  requestNotifyPermission,
} from '../services/notify';
import { PRIVATE_SCOPE, type Theme } from '../types';

const NOTIFY_HINT =
  'Announce drops from your other devices while Milkbox is in the background.';
const NOTIFY_BLOCKED_HINT =
  'Blocked for this site. Allow notifications in your browser settings to turn these on.';

function notifyHint(): string {
  return getNotifyPermission() === 'denied' ? NOTIFY_BLOCKED_HINT : NOTIFY_HINT;
}

// ─── sync diagnostics ───

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "94.2 s · 312 downloaded · 4 skipped · 318 requests · first drops at 93.8 s" */
function describePass(pass: PassStats): string {
  const parts = [
    pass.outcome === 'error' ? `Failed (${pass.error ?? 'error'}) after ${formatSeconds(pass.totalMs)}` : formatSeconds(pass.totalMs),
    `${pass.downloaded} downloaded`,
  ];
  if (pass.skipped) parts.push(`${pass.skipped} skipped`);
  parts.push(`${pass.requests} requests`);
  if (pass.firstCommitMs !== undefined && pass.mode === 'full') {
    parts.push(`first drops at ${formatSeconds(pass.firstCommitMs)}`);
  }
  return parts.join(' · ');
}

function diagnosticsRows(d: Diagnostics): Array<[string, string]> {
  const last = d.passes.at(-1);
  return [
    ['Last full sync', d.lastFull ? `${describePass(d.lastFull)} · ${formatWhen(d.lastFull.startedAt)}` : 'None recorded yet'],
    ['Last sync', last ? `${describePass(last)} · ${formatWhen(last.startedAt)}` : 'None recorded yet'],
    ['On this device', `${d.drops} drops · ${d.devices} device profiles`],
    [
      'Since launch',
      `${d.sinceLaunch.graph} Graph · ${d.sinceLaunch.storage} content requests · ` +
        `${d.sinceLaunch.throttles} throttled · ${d.sinceLaunch.timeouts} timed out · ` +
        `${d.sinceLaunch.backups} sign-in backups`,
    ],
  ];
}

/** Everything the panel shows, plus enough context to read it elsewhere. */
function diagnosticsReport(d: Diagnostics): string {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return JSON.stringify({ at: new Date().toISOString(), userAgent: navigator.userAgent, standalone, ...d }, null, 2);
}

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
  const notifyOn = isNotifyEnabled();
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
                 value="${escapeAttr(getDeviceName())}" aria-label="Device name">
        </section>

        ${
          isNotifySupported()
            ? `
        <section class="settings-section">
          <h3 class="settings-label">Notifications</h3>
          <p class="settings-hint" data-notify-hint>${escapeHtml(notifyHint())}</p>
          <div class="settings-segment" role="radiogroup" aria-label="Notifications">
            <button class="settings-segment-option${notifyOn ? '' : ' selected'}"
                    role="radio" aria-checked="${!notifyOn}" data-notify-option="off">Off</button>
            <button class="settings-segment-option${notifyOn ? ' selected' : ''}"
                    role="radio" aria-checked="${notifyOn}" data-notify-option="on">On</button>
          </div>
        </section>`
            : ''
        }

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
            Your private drops are stored in your OneDrive under <span class="settings-mono">Apps/Milkbox</span>.
            Delete the folder there and everything is gone — this app keeps no other copy.
          </p>
          <p class="settings-hint">
            Shared chats live in the chat host's OneDrive. OneDrive grants every member edit
            access to the whole chat folder — Milkbox's own-drops-only rules are app-level
            courtesy, not OneDrive enforcement.
          </p>
        </section>

        <section class="settings-section">
          <h3 class="settings-label">Sync diagnostics</h3>
          <dl class="settings-stats" data-sync-stats></dl>
          <div class="settings-actions">
            <button class="settings-button" data-settings-action="copy-report" disabled>Copy report</button>
            <button class="settings-button" data-settings-action="resync">Re-sync from scratch</button>
          </div>
        </section>
      </div>
    </section>
  `;

  const panel = container.querySelector<HTMLElement>('.settings-flyout')!;
  const closeButton = panel.querySelector<HTMLButtonElement>('.settings-close')!;
  const deviceInput = panel.querySelector<HTMLInputElement>('.settings-input')!;
  const statsEl = panel.querySelector<HTMLElement>('[data-sync-stats]')!;
  const copyReportButton = panel.querySelector<HTMLButtonElement>('[data-settings-action="copy-report"]')!;
  const resizeObserver = new ResizeObserver(() => {
    if (!panel.hidden) positionPanel();
  });

  /** Built on open, so "Copy report" can write it inside the tap itself —
   *  Safari refuses clipboard writes that happen after an await. */
  let report = '';

  async function paintDiagnostics(): Promise<void> {
    // Nothing to copy until this opening's snapshot is ready — never an
    // empty report, or the one from the last time the panel was open.
    report = '';
    copyReportButton.disabled = true;
    try {
      const diagnostics = await getDiagnostics();
      statsEl.innerHTML = diagnosticsRows(diagnostics)
        .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
        .join('');
      report = diagnosticsReport(diagnostics);
      copyReportButton.disabled = false;
    } catch (err) {
      console.debug('[Settings] Diagnostics unavailable:', err);
      statsEl.innerHTML = '<div><dd>Diagnostics are unavailable right now.</dd></div>';
    }
  }

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
    void paintDiagnostics();
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
    if (panel.contains(target) || trigger.contains(target)) return;

    close();

    // Swallow the click generated by this pointer interaction so the underlying
    // element doesn’t also activate.
    const swallowClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('click', swallowClick, { capture: true, once: true });
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
      // Stop syncing here and tell the other tabs to. The wipe then starts a
      // new store epoch, so a batch still in flight — in any tab — can't
      // land this account's drops afterwards.
      shutdown();
      postBroadcast({ type: 'auth-changed', signedIn: false });
      try {
        await wipeForSignOut();
      } catch (err) {
        console.warn('Failed to clear local data during sign-out:', err);
      }
      // This page is now shut down and on a superseded epoch. If the
      // redirect doesn't happen (MSAL threw, or found no account), a reload
      // is the way back to a working app rather than an inert one.
      let leaving = false;
      try {
        leaving = await signOut();
      } catch (err) {
        console.warn('Sign-out did not start:', err);
      }
      if (!leaving) location.reload();
    });

  copyReportButton.addEventListener('click', async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      showToast('Sync report copied');
    } catch {
      showToast('Copy failed', 'error');
    }
  });

  panel.querySelector<HTMLButtonElement>('[data-settings-action="resync"]')!
    .addEventListener('click', () => {
      if (!confirm('Download your private drops from OneDrive again, as a new install would? Drops waiting to send are kept.')) return;
      close();
      showToast('Re-syncing from OneDrive…');
      resetScope(PRIVATE_SCOPE).catch(err => {
        console.warn('[Settings] Re-sync failed to start:', err);
        showToast('Could not start the re-sync', 'error');
      });
    });

  deviceInput.addEventListener('change', async () => {
    await renameCurrentDevice(deviceInput.value);
    deviceInput.value = getDeviceName();
    showToast('Device name saved');
  });

  const notifyHintEl = panel.querySelector<HTMLElement>('[data-notify-hint]');
  const notifyOptions = [...panel.querySelectorAll<HTMLButtonElement>('[data-notify-option]')];

  function paintNotifyState(): void {
    const on = isNotifyEnabled();
    for (const option of notifyOptions) {
      const selected = (option.dataset.notifyOption === 'on') === on;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-checked', String(selected));
    }
    if (notifyHintEl) notifyHintEl.textContent = notifyHint();
    positionPanel();
  }

  for (const option of notifyOptions) {
    option.addEventListener('click', async () => {
      const wantOn = option.dataset.notifyOption === 'on';
      if (wantOn) {
        // Has to happen in the click handler itself — Safari and Firefox
        // discard a permission request made outside a user gesture.
        const permission = await requestNotifyPermission();
        if (permission !== 'granted') {
          showToast(
            permission === 'denied'
              ? 'Notifications are blocked for this site'
              : 'Notifications need permission',
          );
          paintNotifyState();
          return;
        }
      }
      setNotifyEnabled(wantOn);
      paintNotifyState();
    });
  }

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
      trigger.removeEventListener('click', toggle);
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
      window.removeEventListener('resize', onWindowResize);
      panel.removeEventListener('animationend', onPanelAnimationEnd);
    },
  };
}
