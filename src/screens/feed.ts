/**
 * The feed screen — the private "chat with yourself" and, with a chat scope,
 * a shared chat in someone's OneDrive. Newest drops at the bottom, composer
 * pinned underneath, day dividers between groups. Renders the newest
 * PAGE_SIZE drops; a sentinel at the top pages older ones in from IDB.
 */

import {
  PRIVATE_SCOPE,
  scopeIdOf,
  scopeRefOf,
  type DeviceProfile,
  type DropMeta,
  type DropRecord,
  type Scope,
  type SharePayload,
} from '../types';
import { ulid } from '../utils/ulid';
import { dayKey } from '../utils/format';
import { escapeAttr, escapeHtml } from '../utils/storage';
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
import { startReconnectFlow } from '../services/chat-flows';
import { getAccountId } from '../services/auth';
import { showToast } from '../components/toast';
import { putShareInbox } from '../services/share-inbox';
import { iconBottle, iconChevronDown, iconClose } from '../components/icons';
import { createLimiter } from '../utils/limit';

const PAGE_SIZE = 100;

let teardownFns: Array<() => void> = [];
let composerApi: ComposerApi | null = null;
/** The scope the mounted composer sends to. */
let composerScope: Scope | null = null;
let settingsFlyoutApi: SettingsFlyoutApi | null = null;

/**
 * Object URLs for thumbnails — survive re-renders. Keyed, like the two maps
 * below, by the drop within the scope and, for a chat, within the stay the
 * screen was opened on (see `mkey` in renderFeed): these outlive the screen
 * that filled them, and a chat left and joined again is a later stay, whose
 * screen must not be handed what an earlier one fetched or is still fetching.
 */
const thumbUrls = new Map<string, string>();
/** Preview downloads in flight, keyed like thumbUrls — a re-render mid-download
 *  waits on the same request instead of starting another. */
const thumbInFlight = new Map<string, Promise<Blob | undefined>>();
/** Previews compete with sync for the connection, so only a few at a time. */
const thumbLimiter = createLimiter(3);
/** Drops whose delete is pending the undo window, keyed like thumbUrls. */
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * An unconfirmed share-target payload. Scope switches re-mount the composer,
 * so the payload is held here and re-applied — it follows the user to
 * whichever chat they pick, until they send (or it goes stale). A draft
 * carried across a reload is held only until the scope it was typed in is
 * on screen (see applySharePayload).
 */
let pendingSharePayload: SharePayload | null = null;

/** Closes the open lightbox, if any. */
let closeLightbox: (() => void) | null = null;

/**
 * Something on this screen the user has not sent or saved yet: composer
 * text or attachments, a shared payload waiting in it, an open inline edit.
 * A reload would lose it.
 */
export function hasUnsentDraft(): boolean {
  return Boolean(composerApi?.hasDraft() || pendingSharePayload || document.querySelector('.drop-edit'));
}

/**
 * Reload, taking the composer's draft along. The text and the attachments
 * are left in the share inbox, which every start drains into the composer
 * (see share-inbox.ts). An open inline edit is not carried.
 *
 * With a draft to carry, the address bar is made to name this screen's
 * scope first. A screen opened by restoring the last scope has no hash, and
 * its reload would restore whichever scope a window opened last, which can
 * be another window's chat: the draft has to come back where it was typed.
 *
 * If the draft cannot be left there, the page is not reloaded. It still
 * holds the draft, and says so.
 */
export function reloadKeepingDraft(): void {
  const scope = composerScope;
  void stashDraftForReload().then(
    stashed => {
      if (stashed && scope) {
        const hash = scope.kind === 'chat' ? `#chat/${scope.chatId}` : '#private';
        history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
      }
      location.reload();
    },
    err => {
      console.warn('[Feed] Could not carry the draft across the reload:', err);
      showToast('Couldn’t keep your draft for the reload. Copy it, then reload.', 'error', {
        label: 'Reload anyway',
        onClick: () => location.reload(),
        duration: 10 * 60_000,
      });
    },
  );
}

/**
 * Put what is in the composer where the next start will find it, marked as
 * a draft of this account, typed in this scope. A carried draft still held
 * for another scope (see applySharePayload) goes back there with it. False
 * when the composer holds nothing.
 */
export async function stashDraftForReload(): Promise<boolean> {
  if (pendingSharePayload?.draft) await putShareInbox(pendingSharePayload);
  const draft = composerApi?.draft();
  if (!draft || !composerScope || (!draft.text && !draft.files.length)) return false;
  await putShareInbox({
    text: draft.text,
    files: draft.files,
    receivedAt: Date.now(),
    draft: { accountId: getAccountId(), scopeId: scopeIdOf(composerScope) },
  });
  return true;
}

/** showReloadPrompt has been shown: this page writes nothing until it reloads. */
let reloadAsked = false;

/**
 * Tell the user this page has to be reloaded, with a button that does it
 * and keeps the composer's draft. For a page whose store another window
 * has reset: it can write nothing until it starts again, and from here on
 * it does not route either (see route() in main.ts).
 */
export function showReloadPrompt(message: string): void {
  reloadAsked = true;
  showToast(message, 'info', { label: 'Reload', onClick: reloadKeepingDraft, duration: 10 * 60_000 });
}

/** The user has been asked to reload this page, and it has not reloaded yet. */
export function isReloadAsked(): boolean {
  return reloadAsked;
}

export function teardownScreenListeners(): void {
  closeLightbox?.();
  for (const fn of teardownFns) fn();
  teardownFns = [];
  composerApi?.teardown();
  composerApi = null;
  composerScope = null;
  settingsFlyoutApi?.teardown();
  settingsFlyoutApi = null;
}

export async function renderFeed(
  app: HTMLElement,
  options: { openSettings?: boolean; scope?: Scope } = {},
): Promise<void> {
  const scope: Scope = options.scope ?? PRIVATE_SCOPE;
  const scopeId = scopeIdOf(scope);
  // What this screen's cache writes are made for: the chat as it was held
  // when the screen was drawn.
  const scopeRef = scopeRefOf(scope);
  const isChat = scope.kind === 'chat';
  const title = isChat ? scope.name : 'Milkbox';
  const logLabel = isChat ? `Drops in ${scope.name}` : 'Your drops';

  // A gone or paused chat renders read-only with a banner.
  const chatRecord = isChat ? await db.getChat(scope.chatId) : undefined;
  const chatState = chatRecord?.state ?? 'active';

  // The OS window title (taskbar, window switcher) follows the scope too.
  document.title = title;

  app.innerHTML = `
    <div class="feed-screen">
      <header class="feed-header">
        <div class="feed-header-row">
          <span class="feed-mark">${iconBottle('1.15em')}</span>
          <button class="feed-title-btn" title="Switch chat">
            <span class="feed-wordmark">${escapeHtml(title)}</span><span class="visually-hidden">, switch chat</span>
            <span class="feed-title-chevron">${iconChevronDown('1em')}</span>
            <span class="feed-title-badge" hidden></span>
          </button>
        </div>
      </header>
      <div class="chat-menu-mount"></div>
      <div class="chat-banner" id="chatBanner" hidden></div>
      <div class="feed-scroll" id="feedScroll">
        <div class="feed-sentinel" id="feedSentinel"></div>
        <div class="feed-list" id="feedList" role="log" aria-label="${escapeAttr(logLabel)}"></div>
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
  /** The last pass failed — the first-sync copy says so while it retries. */
  let syncFailed = false;
  /** How far the running pass has got fetching drops. */
  let syncProgress: { received: number; total: number } | null = null;
  /** The list markup on screen. A refresh that would rebuild the same list
   *  (older drops landing below the visible window) leaves it alone. */
  let renderedHtml = '';
  // The key of a drop in the maps that outlive this screen (thumbUrls and
  // the two beside it). For a chat it names the stay as well as the scope:
  // a preview request still running for an earlier stay was made with that
  // stay's scope and its cache write is refused, so the screen of a later
  // one asks for its own instead of waiting on it.
  const stayKey = scope.kind === 'chat' ? `${scopeId}@${scope.generation ?? ''}` : scopeId;
  const mkey = (id: string) => `${stayKey}/${id}`;
  if (scope.kind === 'chat') {
    // Previews drawn on an earlier stay of this chat: no screen will ask for
    // them again, and the screen that showed them is gone. Let them go.
    for (const [key, url] of thumbUrls) {
      if (key.startsWith(`${scopeId}@`) && !key.startsWith(`${stayKey}/`)) {
        URL.revokeObjectURL(url);
        thumbUrls.delete(key);
      }
    }
  }

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
      // Before the first pass lands, empty means "not here yet", not "nothing".
      const fetching = chatState === 'active' && (await coordinator.isFirstSyncPending(scopeId));
      let emptyTitle = isChat ? 'Say hello' : 'The milkbox is empty';
      let emptyDek = isChat
        ? `Drops shared here appear for everyone in ${escapeHtml(scope.name)}.`
        : 'Drop a note, a link, or a file below. It shows up on every device you sign in on.';
      if (fetching) {
        emptyTitle = isChat ? `Fetching ${escapeHtml(scope.name)}` : 'Fetching your drops';
        emptyDek = syncFailed
          ? 'Couldn’t reach OneDrive yet — retrying.'
          : syncProgress?.total
            ? `${syncProgress.received} of ${syncProgress.total} — keep Milkbox open until it finishes.`
            : 'First sync on this device — keep Milkbox open until it finishes.';
      }
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
    // An editor opened while the feed was loading: don't rebuild under it.
    if (listEl.querySelector('.drop-edit')) {
      pendingRefresh = { ...(pendingRefresh ?? {}), ...opts };
      return;
    }
    // Read now, not before the awaits above — the user may have started
    // scrolling up in the meantime.
    const stick = opts.stick ?? nearBottom();
    const rebuilt = html !== renderedHtml;
    if (rebuilt) {
      listEl.innerHTML = html;
      renderedHtml = html;
      hydrateImages();
      hydrateFavicons();
    }
    // A list left untouched stays where the user has it, unless the caller
    // asked for the bottom (a send, the first paint).
    if (rebuilt ? stick : opts.stick === true) scrollToBottom();

    // Not for a list the user has already left: this refresh was under way
    // when they went to another feed, and nothing it drew was shown.
    if (isChat && document.visibilityState === 'visible' && listEl.isConnected) {
      const lastId = feed.length ? feed[feed.length - 1].meta.id : undefined;
      // What was drawn: the page of the feed that is in the list, not all of it.
      void coordinator
        .markScopeRead(scope, lastId, new Set(visible.map(record => record.meta.id)))
        .catch(err => console.debug('[Chats] Mark read failed:', err));
    }
  }

  function flushPendingRefresh(): void {
    const queued = pendingRefresh;
    pendingRefresh = null;
    if (queued) void refresh(queued);
  }

  /**
   * Coalesced refresh for sync events. A first sync commits a batch every
   * few hundred milliseconds and each refresh re-reads the feed from IDB,
   * so one runs at a time, at most every REFRESH_MIN_MS, and requests that
   * arrive meanwhile fold into a single trailing run.
   */
  const REFRESH_MIN_MS = 300;
  let refreshWanted = false;
  let refreshRunning = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRefreshAt = 0;
  teardownFns.push(() => clearTimeout(refreshTimer));

  function scheduleRefresh(): void {
    refreshWanted = true;
    if (refreshRunning || refreshTimer) return;
    const wait = Math.max(0, lastRefreshAt + REFRESH_MIN_MS - performance.now());
    refreshTimer = setTimeout(() => void runScheduledRefresh(), wait);
  }

  async function runScheduledRefresh(): Promise<void> {
    refreshTimer = undefined;
    if (!refreshWanted || !listEl.isConnected) return;
    refreshWanted = false;
    refreshRunning = true;
    try {
      await refresh();
    } catch (err) {
      console.debug('[Feed] Refresh failed:', err);
    } finally {
      refreshRunning = false;
      lastRefreshAt = performance.now();
      if (refreshWanted) scheduleRefresh();
    }
  }

  /**
   * Load preview bytes for image drops: memory → IDB → Graph thumbnail →
   * (fallback) the full image itself. Graph may not have generated a
   * thumbnail yet for a fresh upload, so a miss earns one retry rather
   * than leaving the card blank forever.
   */
  const FULL_IMAGE_PREVIEW_LIMIT = 10 * 1024 * 1024;
  /** A full image standing in for a preview gets this long, then gives its slot back. */
  const FULL_IMAGE_PREVIEW_TIMEOUT_MS = 120_000;
  const thumbRetried = new Set<string>();
  let thumbRetryTimer: ReturnType<typeof setTimeout> | undefined;
  teardownFns.push(() => clearTimeout(thumbRetryTimer));
  // Previews still waiting for a slot are dropped when this screen goes, so
  // the next scope's previews don't queue behind this one's.
  const previewsAbort = new AbortController();
  teardownFns.push(() => previewsAbort.abort());

  /** One retry sweep for every preview that missed, not one per image. */
  function scheduleThumbRetry(delayMs = 4000): void {
    if (thumbRetryTimer) return;
    thumbRetryTimer = setTimeout(() => {
      thumbRetryTimer = undefined;
      if (listEl.isConnected) hydrateImages();
    }, delayMs);
  }

  function loadPreview(id: string): Promise<Blob | undefined> {
    const key = mkey(id);
    let pending = thumbInFlight.get(key);
    if (!pending) {
      pending = fetchPreview(id).finally(() => thumbInFlight.delete(key));
      thumbInFlight.set(key, pending);
    }
    return pending;
  }

  async function fetchPreview(id: string): Promise<Blob | undefined> {
    const file = feed.find(r => r.meta.id === id)?.meta.file;
    const itemId = file?.itemId;
    if (!file || !itemId || coordinator.isThrottled()) return undefined;
    try {
      return await thumbLimiter(async () => {
        // Checked again now that this preview has a slot: it may have been
        // queued before another one's 429 raised the gate. Reported as a
        // miss, the caller sweeps again once the gate lifts.
        if (coordinator.isThrottled()) return undefined;
        const fetched = await fetchThumbnail(scope, itemId);
        if (fetched) {
          await db.putThumb(scopeRef, id, fetched).catch(() => {});
          return fetched;
        }
        // No thumbnail (not generated yet, or unsupported format) — the
        // image itself is small enough to be its own preview.
        if (file.size > FULL_IMAGE_PREVIEW_LIMIT) return undefined;
        const blob = await downloadDropFile(scope, itemId, { timeoutMs: FULL_IMAGE_PREVIEW_TIMEOUT_MS });
        await db.putCachedBlob(scopeRef, id, blob).catch(() => {});
        return blob;
      }, previewsAbort.signal);
    } catch (err) {
      // Offline or transient; a throttle also pauses sync and polling.
      coordinator.noteThrottle(err);
      return undefined;
    }
  }

  function hydrateImages(): void {
    // Newest first: the list is pinned to the bottom, so the last cards are
    // the ones on screen, and previews queue for a few slots in this order.
    const pending = [...listEl.querySelectorAll<HTMLImageElement>('img[data-thumb-id]:not(.loaded)')].reverse();
    pending.forEach(async img => {
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
        blob = await loadPreview(id);
        if (!blob && coordinator.isThrottled()) {
          // Throttled — this miss, or the gate that kept the request from
          // being made at all. That isn't the image's one retry: sweep
          // again once the gate lifts.
          scheduleThumbRetry(coordinator.throttledForMs() + 1000);
        } else if (!blob && !thumbRetried.has(id)) {
          thumbRetried.add(id);
          scheduleThumbRetry();
        }
      }
      // Not for a screen that has gone meanwhile: nothing would show the
      // URL, and it would sit in the map under this screen's key.
      if (blob && listEl.isConnected) {
        // Two cards waiting on one download share one object URL.
        let url = thumbUrls.get(mkey(id));
        if (!url) {
          url = URL.createObjectURL(blob);
          thumbUrls.set(mkey(id), url);
        }
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
    // Whatever was shared has found its home. A carried draft still held is
    // waiting for another scope's composer, and goes on waiting.
    const shared = pendingSharePayload?.draft ? null : pendingSharePayload;
    if (shared) pendingSharePayload = null;
    const drops = buildDrops(text, files);
    let queued = 0;
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
        queued++;
      }
    } catch (err) {
      // The composer emptied itself when it handed this over, and what was
      // not queued is going nowhere. It goes back into the composer. With
      // attachments there is a drop per file, in order, so the files from
      // the failed one on.
      if (listEl.isConnected) {
        composerApi?.restore(text, files.slice(queued));
        if (!queued && shared) pendingSharePayload = shared;
      }
      if (err instanceof db.StaleStoreError) {
        // Another window has reset the store: this page is refused every
        // write until it reloads. The prompt stays up, and its reload takes
        // the draft along.
        showReloadPrompt('This window is out of date and can’t send. Reload it; your draft comes along.');
      } else {
        showToast(err instanceof Error ? err.message : 'Could not send', 'error');
      }
      if (queued) await refresh({ stick: true });
      return;
    }
    await refresh({ stick: true });
  }

  composerApi = mountComposer(
    document.getElementById('composerMount')!,
    (text, files) => void send(text, files),
    name => showToast(`"${name}" is over 250 MB — too big for the milkbox`, 'error'),
    () => coordinator.requestSync(scope, { force: true }),
    { placeholder: isChat ? `Message ${scope.name}` : undefined },
  );
  composerScope = scope;

  /**
   * Draw this chat's screen again, on the record that is held now. The URL
   * is made to name the chat first: a screen opened by restoring the last
   * scope (a bare launch) has no hash, and routing on that a second time
   * draws the private feed. The query string is kept as it is.
   */
  const redrawThisChat = (): void => {
    if (scope.kind !== 'chat') return;
    history.replaceState(null, '', `${location.pathname}${location.search}#chat/${scope.chatId}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  // Gone / paused chat: banner + composer greyed out. Read-only otherwise.
  const banner = document.getElementById('chatBanner')!;
  if (isChat && chatState !== 'active') {
    banner.hidden = false;
    if (chatState === 'gone') {
      banner.innerHTML = `
        <span class="chat-banner-text">You no longer have access to this chat. Showing what was last synced.</span>
        <button class="chat-banner-action" data-banner="remove">Remove from list</button>`;
      composerApi.setDisabled(true, 'No access');
    } else {
      banner.innerHTML = `
        <span class="chat-banner-text">This chat is paused — Milkbox lost its OneDrive access.</span>
        <button class="chat-banner-action" data-banner="reconnect">Reconnect</button>`;
      composerApi.setDisabled(true, 'Paused');
    }
    banner.addEventListener('click', async e => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-banner]')?.dataset.banner;
      if (action === 'remove') {
        let removed: boolean;
        try {
          removed = await coordinator.removeChatLocally(scope.chatId, { generation: scope.generation });
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Could not remove the chat', 'error');
          return;
        }
        if (!removed) {
          // Joined again in another tab since this screen was drawn. That
          // later stay is not the gone chat this button is for: it stays,
          // and this screen is drawn again, on it.
          showToast(`${scope.name} was joined again in another tab, so it is still here.`, 'error');
          redrawThisChat();
          return;
        }
        history.replaceState(null, '', '/');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } else if (action === 'reconnect') {
        startReconnectFlow(scope.chatId);
      }
    });
  }

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
      case 'discard':
        // A refused or failed write leaves the row and its card as they were.
        try {
          // For the send this card was drawn from, not whatever is queued
          // under the drop by now (see DropRecord.sendToken).
          if (action === 'retry') await coordinator.retryOutboxRecord(id, record.sendToken);
          else await coordinator.discardOutboxRecord(id, record.sendToken);
        } catch (err) {
          showToast(err instanceof Error ? err.message : `Could not ${action} the drop`, 'error');
        }
        break;
    }
  });

  function scheduleDelete(record: DropRecord): void {
    const id = record.meta.id;
    const timer = setTimeout(() => {
      pendingDeletes.delete(mkey(id));
      coordinator.enqueueDelete(scope, id).catch(err => {
        // Nothing was queued: say so, and have whichever screen shows this
        // scope now draw the drop again (this one may be long gone).
        showToast(err instanceof Error ? err.message : 'Could not delete the drop', 'error');
        coordinator.refreshFromCache(scopeId);
      });
    }, 5000);
    pendingDeletes.set(mkey(id), timer);
    void refresh();
    showToast('Drop deleted', 'info', {
      label: 'Undo',
      duration: 5000,
      onClick: () => {
        clearTimeout(timer);
        pendingDeletes.delete(mkey(id));
        // The toast outlives this screen: if the scope has been drawn again
        // since, that screen is the one hiding the drop, and is told.
        if (listEl.isConnected) void refresh();
        else coordinator.refreshFromCache(scopeId);
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
          await db.putCachedBlob(scopeRef, record.meta.id, blob).catch(() => {});
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
      <img class="lightbox-img" alt="${escapeAttr(f.name)}">
      <div class="lightbox-caption">${escapeHtml(f.name)}</div>
    `;
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (closeLightbox === close) closeLightbox = null;
    };
    overlay.addEventListener('click', e => {
      if (e.target === overlay || (e.target as HTMLElement).closest('.lightbox-close')) close();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    // It hangs off <body>, not the feed: closed with the screen, or it
    // would outlive it (a scope switch, another tab signing out).
    closeLightbox?.();
    closeLightbox = close;

    const img = overlay.querySelector<HTMLImageElement>('.lightbox-img')!;
    // Show the thumb instantly, then swap in the full-res image
    const thumbUrl = thumbUrls.get(mkey(record.meta.id));
    if (thumbUrl) img.src = thumbUrl;
    try {
      let blob = await db.getCachedBlob(scopeId, record.meta.id).catch(() => undefined);
      if (!blob && f.itemId) {
        blob = await downloadDropFile(scope, f.itemId);
        await db.putCachedBlob(scopeRef, record.meta.id, blob).catch(() => {});
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
    // The list no longer matches its markup — the next refresh must rebuild.
    renderedHtml = '';
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
    const saveBtn = editor.querySelector<HTMLButtonElement>('.drop-edit-save')!;
    saveBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text || text === record.meta.text) {
        closeEditor();
        void refresh();
        return;
      }
      // The editor stays until the edit is queued. If it is refused, what
      // was typed is still there, to copy or to try again; Cancel draws the
      // card as stored.
      saveBtn.disabled = true;
      try {
        await coordinator.enqueueEdit(scope, { ...record.meta, text, editedAt: Date.now() });
      } catch (err) {
        saveBtn.disabled = false;
        if (err instanceof db.StaleStoreError) {
          // As for a send. An open edit is not carried across the reload.
          showReloadPrompt('This window is out of date and can’t save. Copy your edit, then reload.');
        } else {
          showToast(err instanceof Error ? err.message : 'Could not save the edit', 'error');
        }
        return;
      }
      closeEditor();
      void refresh();
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

  // The chat we are showing left the registry (left or deleted on another
  // device, or in another tab): say so and fall back to the private feed.
  const leaveRemovedChat = (chatId: string, name: string | undefined) => {
    if (!isChat || chatId !== scope.chatId) return;
    showToast(`${name ?? scope.name} is no longer on this account`);
    history.replaceState(null, '', '/');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  // The chat was renamed (here, on another device, or in another tab):
  // retitle in place rather than re-rendering the feed.
  const applyRename = async () => {
    if (scope.kind !== 'chat') return;
    const record = await db.getChat(scope.chatId);
    if (!record) return;
    // Access ended, was paused or came back since this screen was drawn:
    // draw it again, so the banner, the composer and the empty-feed copy all
    // follow (an empty chat would otherwise keep saying it is retrying).
    //
    // The same when the chat held is no longer the stay this screen opened
    // on: left and joined again in another tab, with the removal's own
    // broadcast missed (it can arrive before this screen is listening). The
    // screen would go on drawing the later stay's drops, which are stored
    // under the same scope, while its sends and its mark-read are refused
    // as an earlier stay's. Drawn again, it opens on the stay that is held.
    if (((record.state ?? 'active') !== chatState || record.generation !== scope.generation) && listEl.isConnected) {
      redrawThisChat();
      return;
    }
    if (record.name === scope.name) return;
    scope.name = record.name;
    const wordmark = app.querySelector<HTMLElement>('.feed-wordmark');
    if (wordmark) wordmark.textContent = record.name;
    document.title = record.name;
    listEl.setAttribute('aria-label', `Drops in ${record.name}`);
    if (chatState === 'active') composerApi?.setPlaceholder(`Message ${record.name}`);
    if (feed.length === 0) void refresh();
  };
  const onChatsChanged = () => void applyRename().catch(err => console.debug('[Chats] Retitle failed:', err));

  const offCoordinator = coordinator.onCoordinatorEvent(event => {
    if (event.type === 'chats-changed') {
      onChatsChanged(); // the list itself is the switcher's concern
      return;
    }
    if (event.type === 'chat-removed') {
      leaveRemovedChat(event.chatId, event.name);
      return;
    }
    if (event.scopeId !== scopeId) return;
    switch (event.type) {
      case 'sync-start':
        composerApi?.setSyncState('syncing');
        // A pass that was stopped (a re-sync from scratch) ends without a
        // word, its count still standing. The pass starting now has none
        // yet, and an empty first-sync screen must not show the old one.
        syncProgress = null;
        if (feed.length === 0) scheduleRefresh();
        break;
      case 'sync-progress':
        syncProgress = { received: event.received, total: event.total };
        composerApi?.setSyncState('syncing', syncProgress);
        if (feed.length === 0) scheduleRefresh();
        break;
      case 'sync-complete':
        composerApi?.setSyncState('synced');
        syncProgress = null;
        syncFailed = false;
        // An empty feed may have been saying "fetching": a pass that found
        // nothing emits no feed-updated, so re-read the copy here.
        if (feed.length === 0) scheduleRefresh();
        // Previews that missed (offline, throttled, thumbnail not generated
        // yet) get another try once a pass has got through.
        if (listEl.querySelector('img[data-thumb-id]:not(.loaded)')) {
          thumbRetried.clear();
          hydrateImages();
        }
        break;
      case 'sync-error':
        composerApi?.setSyncState('error');
        syncProgress = null;
        syncFailed = true;
        // An empty first-sync screen says it is retrying.
        if (feed.length === 0) scheduleRefresh();
        break;
      case 'feed-updated':
        scheduleRefresh();
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
    } else if (event.type === 'chats-changed') {
      if (event.removedChatId) leaveRemovedChat(event.removedChatId, undefined);
      else onChatsChanged();
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

  // Back from the background: a cTag probe decides whether a pass is needed.
  const onVisible = () => {
    if (document.visibilityState === 'visible') void coordinator.syncIfDirty(scope);
  };
  document.addEventListener('visibilitychange', onVisible);
  teardownFns.push(() => document.removeEventListener('visibilitychange', onVisible));

  // A share payload that arrived before this scope was picked follows the
  // user across switches until they send it. A carried draft waits for the
  // scope it was typed in, and is put back there once.
  if (pendingSharePayload && chatState === 'active') {
    if (!pendingSharePayload.draft) {
      fillComposerFromShare(pendingSharePayload);
    } else if (pendingSharePayload.draft.scopeId === scopeId) {
      fillComposerFromShare(pendingSharePayload);
      pendingSharePayload = null;
    }
  }

  // ── first paint: IDB-first render, then network ──

  await refresh({ stick: true });
  void coordinator.requestSync(scope, { force: true });
}

function fillComposerFromShare(payload: SharePayload): void {
  if (!composerApi) return;
  const text = payload.url || payload.text || payload.title || '';
  if (text) composerApi.setText(text);
  if (payload.files.length) composerApi.addFiles(payload.files);
  composerApi.focus();
}

/**
 * Handle a share-target payload: pre-fill the composer, never auto-send.
 * A share follows the user from chat to chat until it is sent. A draft
 * carried across a reload does not: it goes, once, into the composer of
 * the scope it was typed in. The reload comes back to that scope (see
 * reloadKeepingDraft), but the page can have moved on by the time the
 * draft arrives, to a chat that a join resumed at start-up has just
 * opened, for one. Then the draft is held until its own scope is on screen.
 */
export function applySharePayload(payload: SharePayload): void {
  if (payload.draft) {
    if (composerApi && composerScope && scopeIdOf(composerScope) === payload.draft.scopeId) {
      fillComposerFromShare(payload);
    } else {
      pendingSharePayload = payload;
    }
    return;
  }
  pendingSharePayload = payload;
  fillComposerFromShare(payload);
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
