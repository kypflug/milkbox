/**
 * The feed — a chat with yourself. Newest drops at the bottom, composer
 * pinned underneath, day dividers between groups. Renders the newest
 * PAGE_SIZE drops; a sentinel at the top pages older ones in from IDB.
 */

import type { DropMeta, DropRecord, SharePayload } from '../types';
import { ulid } from '../utils/ulid';
import { dayKey } from '../utils/format';
import { escapeHtml } from '../utils/storage';
import { getDeviceInfo } from '../services/device';
import { isBareUrl, domainOf } from '../services/link-meta';
import * as coordinator from '../services/sync-coordinator';
import * as db from '../services/db';
import { fetchThumbnail, downloadDropFile } from '../services/graph';
import { onBroadcast } from '../services/broadcast';
import { renderDropCard } from '../components/drop-card';
import { renderDayDivider } from '../components/day-divider';
import { mountComposer, type ComposerApi } from '../components/composer';
import { showToast } from '../components/toast';
import { iconBottle, iconSettings, iconClose } from '../components/icons';

const PAGE_SIZE = 100;

let teardownFns: Array<() => void> = [];
let composerApi: ComposerApi | null = null;

/** Object URLs for thumbnails, keyed by drop id — survive re-renders. */
const thumbUrls = new Map<string, string>();
/** Drops whose delete is pending the undo window. */
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

export function teardownScreenListeners(): void {
  for (const fn of teardownFns) fn();
  teardownFns = [];
  composerApi?.teardown();
  composerApi = null;
}

export async function renderFeed(app: HTMLElement): Promise<void> {
  app.innerHTML = `
    <div class="feed-screen">
      <header class="feed-header">
        <div class="feed-titlebar" aria-hidden="true"></div>
        <div class="feed-header-row">
          <span class="feed-wordmark">${iconBottle('1.15em')}<span>Milkbox</span></span>
          <span class="sync-dot" id="syncDot" title="Synced"></span>
          <a class="feed-settings" href="#settings" title="Settings" aria-label="Settings">${iconSettings('1.2em')}</a>
        </div>
      </header>
      <div class="feed-scroll" id="feedScroll">
        <div class="feed-sentinel" id="feedSentinel"></div>
        <div class="feed-list" id="feedList" role="log" aria-label="Your drops"></div>
      </div>
      <div class="composer-mount" id="composerMount"></div>
    </div>
  `;

  const scrollEl = document.getElementById('feedScroll')!;
  const listEl = document.getElementById('feedList')!;
  const syncDot = document.getElementById('syncDot')!;

  let visibleCount = PAGE_SIZE;
  let feed: DropRecord[] = [];

  function nearBottom(): boolean {
    return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 120;
  }

  function scrollToBottom(): void {
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  async function refresh(opts: { stick?: boolean } = {}): Promise<void> {
    const stick = opts.stick ?? nearBottom();
    feed = await coordinator.loadFeed();
    const visible = feed.slice(-visibleCount).filter(r => !pendingDeletes.has(r.meta.id));

    let html = '';
    if (visible.length === 0) {
      html = `
        <div class="feed-empty">
          <div class="feed-empty-glyph">${iconBottle('40px')}</div>
          <p class="feed-empty-title">The milkbox is empty</p>
          <p class="feed-empty-dek">Drop a note, a link, or a file below. It shows up on every device you sign in on.</p>
        </div>`;
    } else {
      let lastDay = '';
      for (const record of visible) {
        const day = dayKey(record.meta.createdAt);
        if (day !== lastDay) {
          html += renderDayDivider(record.meta.createdAt);
          lastDay = day;
        }
        html += renderDropCard(record);
      }
    }
    listEl.innerHTML = html;
    hydrateImages();
    hydrateFavicons();
    if (stick) scrollToBottom();
  }

  /** Load thumbnail bytes for image drops: memory → IDB → Graph. */
  function hydrateImages(): void {
    listEl.querySelectorAll<HTMLImageElement>('img[data-thumb-id]').forEach(async img => {
      const id = img.dataset.thumbId!;
      const cached = thumbUrls.get(id);
      if (cached) {
        img.src = cached;
        return;
      }
      let blob = (await db.getThumb(id).catch(() => undefined))
        || (await db.getCachedBlob(id).catch(() => undefined));
      if (!blob) {
        const record = feed.find(r => r.meta.id === id);
        const itemId = record?.meta.file?.itemId;
        if (!itemId) return;
        try {
          const fetched = await fetchThumbnail(itemId);
          if (fetched) {
            blob = fetched;
            await db.putThumb(id, fetched).catch(() => {});
          }
        } catch { /* offline — placeholder stays */ }
      }
      if (blob) {
        const url = URL.createObjectURL(blob);
        thumbUrls.set(id, url);
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

    if (text && files.length === 0) {
      if (isBareUrl(text)) {
        const url = text.trim();
        out.push({
          meta: {
            v: 1, id: ulid(), kind: 'link', createdAt: Date.now(), device,
            url, link: { domain: domainOf(url) },
          },
        });
      } else {
        out.push({
          meta: { v: 1, id: ulid(), kind: 'text', createdAt: Date.now(), device, text },
        });
      }
    }
    return out;
  }

  async function measureImage(blob: Blob): Promise<{ width: number; height: number } | null> {
    try {
      const bmp = await createImageBitmap(blob);
      const dims = { width: bmp.width, height: bmp.height };
      bmp.close();
      return dims;
    } catch {
      return null;
    }
  }

  async function send(text: string, files: File[]): Promise<void> {
    const drops = buildDrops(text, files);
    for (const drop of drops) {
      if (drop.meta.kind === 'image' && drop.blob) {
        const dims = await measureImage(drop.blob);
        if (dims && drop.meta.file) {
          drop.meta.file.width = dims.width;
          drop.meta.file.height = dims.height;
        }
      }
      await coordinator.enqueueCreate(drop.meta, drop.blob);
    }
    await refresh({ stick: true });
  }

  composerApi = mountComposer(
    document.getElementById('composerMount')!,
    (text, files) => void send(text, files),
    name => showToast(`"${name}" is over 250 MB — too big for the milkbox`, 'error'),
  );

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

    switch (action) {
      case 'copy': {
        const value = record.meta.kind === 'link' ? record.meta.url || '' : record.meta.text || '';
        try {
          await navigator.clipboard.writeText(value);
          showToast('Copied');
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
        startInlineEdit(card, record);
        break;
      case 'delete':
        scheduleDelete(record);
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
      pendingDeletes.delete(id);
      void coordinator.enqueueDelete(id);
    }, 5000);
    pendingDeletes.set(id, timer);
    void refresh();
    showToast('Drop deleted', 'info', {
      label: 'Undo',
      duration: 5000,
      onClick: () => {
        clearTimeout(timer);
        pendingDeletes.delete(id);
        void refresh();
      },
    });
  }

  async function downloadFile(record: DropRecord): Promise<void> {
    const f = record.meta.file;
    if (!f) return;
    try {
      let blob = await db.getCachedBlob(record.meta.id).catch(() => undefined);
      if (!blob) {
        if (!f.itemId) {
          showToast('Still uploading…');
          return;
        }
        showToast('Downloading…');
        blob = await downloadDropFile(f.itemId);
        if (record.meta.kind === 'image') {
          await db.putCachedBlob(record.meta.id, blob).catch(() => {});
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
    const thumbUrl = thumbUrls.get(record.meta.id);
    if (thumbUrl) img.src = thumbUrl;
    try {
      let blob = await db.getCachedBlob(record.meta.id).catch(() => undefined);
      if (!blob && f.itemId) {
        blob = await downloadDropFile(f.itemId);
        await db.putCachedBlob(record.meta.id, blob).catch(() => {});
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

    editor.querySelector('.drop-edit-cancel')!.addEventListener('click', () => void refresh());
    editor.querySelector('.drop-edit-save')!.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text || text === record.meta.text) {
        void refresh();
        return;
      }
      await coordinator.enqueueEdit({ ...record.meta, text, editedAt: Date.now() });
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
    switch (event.type) {
      case 'sync-start':
        syncDot.classList.add('syncing');
        break;
      case 'sync-complete':
        syncDot.classList.remove('syncing', 'error');
        syncDot.title = 'Synced';
        break;
      case 'sync-error':
        syncDot.classList.remove('syncing');
        syncDot.classList.add('error');
        syncDot.title = 'Sync failed — will retry';
        break;
      case 'feed-updated':
        void refresh();
        break;
      case 'drop-progress': {
        const bar = listEl.querySelector<HTMLElement>(
          `[data-drop-id="${event.dropId}"] .drop-image-progress`,
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
      coordinator.refreshFromCache();
    }
  });
  teardownFns.push(offBroadcast);

  // Poll while visible — gated by the folder cTag check, so the steady-state
  // cost is one tiny GET per tick.
  const poll = setInterval(() => {
    if (document.visibilityState === 'visible') void coordinator.pollTick();
  }, 45_000);
  teardownFns.push(() => clearInterval(poll));

  const onVisible = () => {
    if (document.visibilityState === 'visible') void coordinator.requestSync();
  };
  document.addEventListener('visibilitychange', onVisible);
  teardownFns.push(() => document.removeEventListener('visibilitychange', onVisible));

  // ── first paint: IDB-first render, then network ──

  await refresh({ stick: true });
  void coordinator.requestSync({ force: true });
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
