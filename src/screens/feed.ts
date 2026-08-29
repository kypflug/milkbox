/**
 * The feed screen — the private "chat with yourself" and, with a chat scope,
 * a shared chat in someone's OneDrive. Newest drops at the bottom, composer
 * pinned underneath, day dividers between groups. Renders the newest
 * PAGE_SIZE drops; a sentinel at the top pages older ones in from IDB.
 */

import {
  PRIVATE_SCOPE,
  scopeIdOf,
  type DeviceProfile,
  type DropMeta,
  type DropRecord,
  type Scope,
  type SharePayload,
} from '../types';
import { ulid } from '../utils/ulid';
import { dayKey } from '../utils/format';
import { escapeHtml } from '../utils/storage';
import { getDeviceId, getDeviceInfo } from '../services/device';
import { isBareUrl, domainOf } from '../services/link-meta';
import * as coordinator from '../services/sync-coordinator';
import * as db from '../services/db';
import { fetchThumbnail, downloadDropFile } from '../services/graph';
import { onBroadcast } from '../services/broadcast';
import { isNotifyEnabled } from '../services/notify';
import { renderDropCard, type DropCardPresentation } from '../components/drop-card';
import { renderDayDivider } from '../components/day-divider';
import { mountComposer, type ComposerApi } from '../components/composer';
import { mountSettingsFlyout, type SettingsFlyoutApi } from './settings';
import { showToast } from '../components/toast';
import { iconBottle, iconClose } from '../components/icons';

const PAGE_SIZE = 100;

let teardownFns: Array<() => void> = [];
let composerApi: ComposerApi | null = null;
let settingsFlyoutApi: SettingsFlyoutApi | null = null;

/** Object URLs for thumbnails, keyed by `${scopeId}/${dropId}` — survive re-renders. */
const thumbUrls = new Map<string, string>();
/** Drops whose delete is pending the undo window, keyed by `${scopeId}/${dropId}`. */
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

export function teardownScreenListeners(): void {
  for (const fn of teardownFns) fn();
  teardownFns = [];
  composerApi?.teardown();
  composerApi = null;
  settingsFlyoutApi?.teardown();
  settingsFlyoutApi = null;
}

export async function renderFeed(
  app: HTMLElement,
  options: { openSettings?: boolean; scope?: Scope } = {},
): Promise<void> {
  const scope: Scope = options.scope ?? PRIVATE_SCOPE;
  const scopeId = scopeIdOf(scope);
  const isChat = scope.kind === 'chat';
  const title = isChat ? scope.name : 'Milkbox';
  const logLabel = isChat ? `Drops in ${scope.name}` : 'Your drops';

  app.innerHTML = `
    <div class="feed-screen">
      <header class="feed-header">
        <div class="feed-header-row">
          <span class="feed-mark">${iconBottle('1.15em')}</span>
          <span class="feed-wordmark">${escapeHtml(title)}</span>
        </div>
      </header>
      <div class="feed-scroll" id="feedScroll">
        <div class="feed-sentinel" id="feedSentinel"></div>
        <div class="feed-list" id="feedList" role="log" aria-label="${escapeHtml(logLabel)}"></div>
      </div>
      <div class="composer-region" id="composerRegion">
        <div class="settings-flyout-mount"></div>
        <div class="composer-mount" id="composerMount"></div>
      </div>
    </div>
  `;

  const scrollEl = document.getElementById('feedScroll')!;
  const listEl = document.getElementById('feedList')!;

  let visibleCount = PAGE_SIZE;
  let feed: DropRecord[] = [];
  const mkey = (id: string) => `${scopeId}/${id}`;

  // Author identity for chat attribution. Resolved from IDB after the first
  // ever fetch; for the private feed it's never awaited on the render path.
  const mePromise = isChat ? coordinator.ensureMe() : Promise.resolve(null);

  /** Informational toasts yield to a pending delete-undo toast (a new toast
   *  would destroy the undo affordance while its timer keeps running). */
  const infoToast = (message: string) => {
    if (pendingDeletes.size === 0) showToast(message);
  };

  function nearBottom(): boolean {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
  }

  function scrollToBottom(): void {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  function permsFor(own: boolean): { canEdit: boolean; canDelete: boolean } {
    if (!isChat) return { canEdit: true, canDelete: true };
    return { canEdit: own, canDelete: own || scope.role === 'host' };
  }

  /** Re-render deferred while an inline editor is open — any member posting
   *  would otherwise destroy in-progress typing (full-innerHTML pipeline). */
  let pendingRefresh: { stick?: boolean } | null = null;

  async function refresh(opts: { stick?: boolean } = {}): Promise<void> {
    if (listEl.querySelector('.drop-edit')) {
      pendingRefresh = { ...(pendingRefresh ?? {}), ...opts };
      return;
    }
    const stick = opts.stick ?? nearBottom();
    const [loadedFeed, profiles, me] = await Promise.all([
      coordinator.loadFeed(scopeId),
      isChat ? Promise.resolve([] as DeviceProfile[]) : coordinator.loadDeviceProfiles(),
      mePromise,
    ]);
    feed = loadedFeed;
    const deviceLabels = buildDeviceLabels(profiles);
    const currentDeviceId = getDeviceId();
    const visible = feed.slice(-visibleCount).filter(r => !pendingDeletes.has(mkey(r.meta.id)));

    let html = '';
    if (visible.length === 0) {
      const emptyTitle = isChat ? 'Say hello' : 'The milkbox is empty';
      const emptyDek = isChat
        ? `Drops shared here appear for everyone in ${escapeHtml(scope.name)}.`
        : 'Drop a note, a link, or a file below. It shows up on every device you sign in on.';
      html = `
        <div class="feed-empty">
          <div class="feed-empty-glyph">${iconBottle('40px')}</div>
          <p class="feed-empty-title">${emptyTitle}</p>
          <p class="feed-empty-dek">${emptyDek}</p>
        </div>`;
    } else {
      let lastDay = '';
      for (const record of visible) {
        const day = dayKey(record.meta.createdAt);
        if (day !== lastDay) {
          html += renderDayDivider(record.meta.createdAt);
          lastDay = day;
        }
        let own: boolean;
        let attributionLabel: string;
        if (isChat) {
          own = !!me && record.meta.author?.id === me.id;
          attributionLabel = record.meta.author?.name ?? scope.host.name;
        } else {
          const profileId = record.meta.device.id;
          own = profileId === currentDeviceId;
          attributionLabel = (profileId && deviceLabels.get(profileId)) || record.meta.device.name;
        }
        const presentation: DropCardPresentation = {
          side: own ? 'sent' : 'received',
          attributionLabel,
          ...permsFor(own),
        };
        html += renderDropCard(record, presentation);
      }
    }
    listEl.innerHTML = html;
    hydrateImages();
    hydrateFavicons();
    if (stick) scrollToBottom();

    if (isChat && document.visibilityState === 'visible') {
      const lastId = feed.length ? feed[feed.length - 1].meta.id : undefined;
      void coordinator.markScopeRead(scopeId, lastId);
    }
  }

  function flushPendingRefresh(): void {
    const queued = pendingRefresh;
    pendingRefresh = null;
    if (queued) void refresh(queued);
  }

  /**
   * Load preview bytes for image drops: memory → IDB → Graph thumbnail →
   * (fallback) the full image itself. Graph may not have generated a
   * thumbnail yet for a fresh upload, so a miss schedules one retry rather
   * than leaving the card blank forever.
   */
  const FULL_IMAGE_PREVIEW_LIMIT = 10 * 1024 * 1024;
  const thumbRetried = new Set<string>();

  function hydrateImages(): void {
    listEl.querySelectorAll<HTMLImageElement>('img[data-thumb-id]').forEach(async img => {
      const id = img.dataset.thumbId!;
      const cached = thumbUrls.get(mkey(id));
      if (cached) {
        img.src = cached;
        img.classList.add('loaded');
        return;
      }
      let blob = (await db.getThumb(scopeId, id).catch(() => undefined))
        || (await db.getCachedBlob(scopeId, id).catch(() => undefined));
      if (!blob) {
        const record = feed.find(r => r.meta.id === id);
        const file = record?.meta.file;
        if (!file?.itemId) return;
        try {
          const fetched = await fetchThumbnail(scope, file.itemId);
          if (fetched) {
            blob = fetched;
            await db.putThumb(scopeId, id, fetched).catch(() => {});
          } else if (file.size <= FULL_IMAGE_PREVIEW_LIMIT) {
            // No thumbnail (not generated yet, or unsupported format) —
            // the image itself is small enough to be its own preview.
            blob = await downloadDropFile(scope, file.itemId);
            await db.putCachedBlob(scopeId, id, blob).catch(() => {});
          }
        } catch { /* offline or transient — retry below */ }
        if (!blob && !thumbRetried.has(id)) {
          thumbRetried.add(id);
          setTimeout(() => {
            if (listEl.isConnected) hydrateImages();
          }, 4000);
        }
      }
      if (blob) {
        const url = URL.createObjectURL(blob);
        thumbUrls.set(mkey(id), url);
        img.src = url;
        img.classList.add('loaded');
      }
    });
  }

  function hydrateFavicons(): void {
    listEl.querySelectorAll<HTMLImageElement>('.drop-link-favicon').forEach(img => {
      if (img.complete && img.naturalWidth > 0) img.classList.add('loaded');
      else img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    });
  }

  // ── sending ──

  function buildDrops(text: string, files: File[]): Array<{ meta: DropMeta; blob?: Blob }> {
    const device = getDeviceInfo();
    const out: Array<{ meta: DropMeta; blob?: Blob }> = [];
    const caption = files.length > 0 ? text : '';

    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const id = ulid();
      out.push({
        meta: {
          v: 1,
          id,
          kind: isImage ? 'image' : 'file',
          createdAt: Date.now(),
          device,
          ...(caption ? { text: caption } : {}),
          file: {
            name: file.name,
            size: file.size,
            mime: file.type || 'application/octet-stream',
            path: `files/${id}/${sanitizeName(file.name)}`,
          },
        },
        blob: file,
      });
    }

    const trimmed = text.trim();
    if (trimmed && files.length === 0) {
      const id = ulid();
      if (isBareUrl(trimmed)) {
        out.push({
          meta: {
            v: 1, id, kind: 'link', createdAt: Date.now(), device,
            url: trimmed,
            link: { domain: domainOf(trimmed) },
          },
        });
      } else {
        out.push({
          meta: { v: 1, id, kind: 'text', createdAt: Date.now(), device, text: trimmed },
        });
      }
    }
    return out;
  }

  async function measureImage(blob: Blob): Promise<{ width: number; height: number } | null> {
    try {
      const bitmap = await createImageBitmap(blob);
      const dims = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dims;
    } catch {
      return null;
    }
  }

  async function send(text: string, files: File[]): Promise<void> {
    const drops = buildDrops(text, files);
    try {
      for (const drop of drops) {
        if (drop.meta.kind === 'image' && drop.blob) {
          const dims = await measureImage(drop.blob);
          if (dims && drop.meta.file) {
            drop.meta.file.width = dims.width;
            drop.meta.file.height = dims.height;
          }
        }
        await coordinator.enqueueCreate(scope, drop.meta, drop.blob);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not send', 'error');
      return;
    }
    await refresh({ stick: true });
  }

  composerApi = mountComposer(
    document.getElementById('composerMount')!,
    (text, files) => void send(text, files),
    name => showToast(`"${name}" is over 250 MB — too big for the milkbox`, 'error'),
    () => coordinator.requestSync(scope, { force: true }),
  );
  const settingsTrigger = app.querySelector<HTMLButtonElement>('.composer-settings')!;
  settingsFlyoutApi = mountSettingsFlyout(
    app.querySelector<HTMLElement>('.settings-flyout-mount')!,
    settingsTrigger,
    app.querySelector<HTMLElement>('.feed-header-row')!,
  );
  if (options.openSettings) settingsFlyoutApi.open();

  // ── card actions (event delegation) ──

  listEl.addEventListener('click', async e => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>('[data-action]');
    if (!actionEl) return;
    const card = actionEl.closest<HTMLElement>('[data-drop-id]');
    if (!card) return;
    const id = card.dataset.dropId!;
    const record = feed.find(r => r.meta.id === id);
    if (!record) return;
    const action = actionEl.dataset.action!;

    // Re-check moderation on dispatch — the DOM is user-editable, the rules
    // aren't (soft-enforced, but not bypassable by editing a button in).
    const me = await mePromise;
    const own = isChat ? !!me && record.meta.author?.id === me.id : true;
    const perms = permsFor(own);

    switch (action) {
      case 'copy': {
        const value = record.meta.kind === 'link' ? record.meta.url || '' : record.meta.text || '';
        try {
          await navigator.clipboard.writeText(value);
          infoToast('Copied');
        } catch {
          showToast('Copy failed', 'error');
        }
        break;
      }
      case 'download':
        await downloadFile(record);
        break;
      case 'lightbox':
        await openLightbox(record);
        break;
      case 'edit':
        if (perms.canEdit) startInlineEdit(card, record);
        break;
      case 'delete':
        if (perms.canDelete) scheduleDelete(record);
        break;
      case 'retry':
        await coordinator.retryOutboxRecord(id);
        break;
      case 'discard':
        await coordinator.discardOutboxRecord(id);
        break;
    }
  });

  function scheduleDelete(record: DropRecord): void {
    const id = record.meta.id;
    const timer = setTimeout(() => {
      pendingDeletes.delete(mkey(id));
      void coordinator.enqueueDelete(scope, id);
    }, 5000);
    pendingDeletes.set(mkey(id), timer);
    void refresh();
    showToast('Drop deleted', 'info', {
      label: 'Undo',
      duration: 5000,
      onClick: () => {
        clearTimeout(timer);
        pendingDeletes.delete(mkey(id));
        void refresh();
      },
    });
  }

  async function downloadFile(record: DropRecord): Promise<void> {
    const f = record.meta.file;
    if (!f) return;
    try {
      let blob = await db.getCachedBlob(scopeId, record.meta.id).catch(() => undefined);
      if (!blob) {
        if (!f.itemId) {
          infoToast('Still uploading…');
          return;
        }
        infoToast('Downloading…');
        blob = await downloadDropFile(scope, f.itemId);
        if (record.meta.kind === 'image') {
          await db.putCachedBlob(scopeId, record.meta.id, blob).catch(() => {});
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      console.warn('Download failed:', err);
      showToast('Download failed — are you offline?', 'error');
    }
  }

  async function openLightbox(record: DropRecord): Promise<void> {
    const f = record.meta.file;
    if (!f) return;
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';
    overlay.innerHTML = `
      <button class="lightbox-close" aria-label="Close">${iconClose('1.3em')}</button>
      <img class="lightbox-img" alt="${escapeHtml(f.name)}">
      <div class="lightbox-caption">${escapeHtml(f.name)}</div>
    `;
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => {
      if (e.target === overlay || (e.target as HTMLElement).closest('.lightbox-close')) close();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);

    const img = overlay.querySelector<HTMLImageElement>('.lightbox-img')!;
    // Show the thumb instantly, then swap in the full-res image
    const thumbUrl = thumbUrls.get(mkey(record.meta.id));
    if (thumbUrl) img.src = thumbUrl;
    try {
      let blob = await db.getCachedBlob(scopeId, record.meta.id).catch(() => undefined);
      if (!blob && f.itemId) {
        blob = await downloadDropFile(scope, f.itemId);
        await db.putCachedBlob(scopeId, record.meta.id, blob).catch(() => {});
      }
      if (blob) img.src = URL.createObjectURL(blob);
    } catch { /* keep the thumb */ }
  }

  function startInlineEdit(card: HTMLElement, record: DropRecord): void {
    const textEl = card.querySelector<HTMLElement>('.drop-text');
    if (!textEl || card.querySelector('.drop-edit')) return;
    const editor = document.createElement('div');
    editor.className = 'drop-edit';
    editor.innerHTML = `
      <textarea class="drop-edit-input" aria-label="Edit drop"></textarea>
      <div class="drop-edit-row">
        <button class="drop-edit-cancel">Cancel</button>
        <button class="drop-edit-save">Save</button>
      </div>
    `;
    const input = editor.querySelector<HTMLTextAreaElement>('.drop-edit-input')!;
    input.value = record.meta.text || '';
    textEl.replaceWith(editor);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    // Remove the editor before re-rendering so the deferred-refresh guard
    // can't wedge on our own editor node.
    const closeEditor = () => {
      editor.remove();
      flushPendingRefresh();
    };
    editor.querySelector('.drop-edit-cancel')!.addEventListener('click', () => {
      closeEditor();
      void refresh();
    });
    editor.querySelector('.drop-edit-save')!.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text || text === record.meta.text) {
        closeEditor();
        void refresh();
        return;
      }
      closeEditor();
      await coordinator.enqueueEdit(scope, { ...record.meta, text, editedAt: Date.now() });
    });
  }

  // ── pagination sentinel ──

  const sentinel = document.getElementById('feedSentinel')!;
  const observer = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting) && visibleCount < feed.length) {
      visibleCount += PAGE_SIZE;
      void refresh({ stick: false });
    }
  });
  observer.observe(sentinel);
  teardownFns.push(() => observer.disconnect());

  // ── sync wiring ──

  const offCoordinator = coordinator.onCoordinatorEvent(event => {
    if (event.type === 'chats-changed') return; // the switcher's concern
    if (event.scopeId !== scopeId) return;
    switch (event.type) {
      case 'sync-start':
        composerApi?.setSyncState('syncing');
        break;
      case 'sync-complete':
        composerApi?.setSyncState('synced');
        break;
      case 'sync-error':
        composerApi?.setSyncState('error');
        break;
      case 'feed-updated':
        void refresh();
        break;
      case 'drop-conflict':
        showToast('A drop you changed was edited or removed by someone else', 'error');
        break;
      case 'drop-progress': {
        const bar = listEl.querySelector<HTMLElement>(
          `[data-drop-id="${CSS.escape(event.dropId)}"] .drop-image-progress`,
        );
        if (bar) {
          bar.hidden = false;
          const fill = bar.querySelector<HTMLElement>('.drop-image-progress-fill');
          if (fill) fill.style.width = `${Math.round(event.fraction * 100)}%`;
        }
        break;
      }
    }
  });
  teardownFns.push(offCoordinator);

  const offBroadcast = onBroadcast(event => {
    if (event.type === 'sync-complete' || event.type === 'drop-mutated') {
      // Old builds broadcast without a scopeId — treat those as ours.
      coordinator.refreshFromCache(event.scopeId ?? scopeId);
    }
  });
  teardownFns.push(offBroadcast);

  // Poll while visible — gated by the folder cTag check, so the steady-state
  // cost is a few tiny GETs per tick (active scope + one background scope).
  // With notifications on we keep ticking while hidden too, since that poll
  // is the only thing that can spot an arrival to announce; browsers clamp
  // hidden-tab timers to about a minute, the gentler cadence we want there.
  const poll = setInterval(() => {
    if (document.visibilityState === 'visible' || isNotifyEnabled()) {
      void coordinator.pollAll(scopeId);
    }
  }, 45_000);
  teardownFns.push(() => clearInterval(poll));

  const onVisible = () => {
    if (document.visibilityState === 'visible') void coordinator.requestSync(scope);
  };
  document.addEventListener('visibilitychange', onVisible);
  teardownFns.push(() => document.removeEventListener('visibilitychange', onVisible));

  // ── first paint: IDB-first render, then network ──

  await refresh({ stick: true });
  void coordinator.requestSync(scope, { force: true });
}

/** Handle a share-target payload: pre-fill the composer, never auto-send. */
export function applySharePayload(payload: SharePayload): void {
  if (!composerApi) return;
  const text = payload.url || payload.text || payload.title || '';
  if (text) composerApi.setText(text);
  if (payload.files.length) composerApi.addFiles(payload.files);
  composerApi.focus();
}

function sanitizeName(name: string): string {
  // OneDrive disallows a handful of characters in item names
  return name.replace(/[\\/:*?"<>|#%]/g, '_').slice(0, 180) || 'file';
}

function buildDeviceLabels(profiles: DeviceProfile[]): Map<string, string> {
  const byName = new Map<string, DeviceProfile[]>();
  for (const profile of profiles) {
    const key = profile.name.trim().toLocaleLowerCase();
    const group = byName.get(key) || [];
    group.push(profile);
    byName.set(key, group);
  }

  const labels = new Map<string, string>();
  for (const group of byName.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    group.forEach((profile, index) => {
      labels.set(profile.id, index === 0 ? profile.name : `${profile.name} #${index + 1}`);
    });
  }
  return labels;
}
