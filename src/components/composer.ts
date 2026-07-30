/**
 * The composer — a pinned bar with an auto-growing textarea, attach button,
 * attachment chips, drag-drop overlay, and paste-to-attach.
 *
 * The composer doesn't know about Graph or the outbox; it calls `onSend`
 * with the text and files and lets the feed screen queue drops.
 */

import { iconAttach, iconSend, iconClose, iconFile, iconRefresh, iconSettings } from './icons';
import { escapeHtml } from '../utils/storage';
import { formatBytes } from '../utils/format';

export interface ComposerApi {
  /** Pre-fill the textarea (share target). */
  setText(text: string): void;
  /** Add attachments (share target, drag-drop). */
  addFiles(files: File[]): void;
  focus(): void;
  setSyncState(state: 'syncing' | 'synced' | 'error'): void;
  teardown(): void;
}

const MAX_ATTACH_BYTES = 250 * 1024 * 1024;
const MAX_INPUT_LINES = 3;

export function mountComposer(
  container: HTMLElement,
  onSend: (text: string, files: File[]) => void,
  onOversize: (name: string) => void,
  onRefresh: () => Promise<void>,
): ComposerApi {
  container.innerHTML = `
    <div class="composer">
      <div class="composer-chips" hidden></div>
      <div class="composer-row">
        <button class="composer-attach" title="Attach files" aria-label="Attach files">${iconAttach('1.25em')}</button>
        <textarea class="composer-input" rows="1" placeholder="Drop something…" aria-label="Message"></textarea>
        <span class="composer-tools">
          <button class="composer-refresh" title="Refresh" aria-label="Refresh">${iconRefresh('1.15em')}</button>
          <button class="composer-settings" title="Settings" aria-label="Settings"
                  aria-haspopup="dialog">${iconSettings('1.15em')}</button>
        </span>
        <button class="composer-send" title="Send" aria-label="Send">${iconSend('1.2em')}</button>
      </div>
      <input type="file" class="composer-file-input" multiple hidden>
    </div>
    <div class="drag-overlay" hidden aria-hidden="true">
      <div class="drag-overlay-card">Drop it in the milkbox</div>
    </div>
  `;

  const chipsEl = container.querySelector<HTMLElement>('.composer-chips')!;
  const inputEl = container.querySelector<HTMLTextAreaElement>('.composer-input')!;
  const sendBtn = container.querySelector<HTMLButtonElement>('.composer-send')!;
  const refreshBtn = container.querySelector<HTMLButtonElement>('.composer-refresh')!;
  const attachBtn = container.querySelector<HTMLButtonElement>('.composer-attach')!;
  const fileInput = container.querySelector<HTMLInputElement>('.composer-file-input')!;
  const dragOverlay = container.querySelector<HTMLElement>('.drag-overlay')!;

  let pendingFiles: File[] = [];

  function setSyncState(state: 'syncing' | 'synced' | 'error'): void {
    refreshBtn.classList.toggle('syncing', state === 'syncing');
    refreshBtn.classList.toggle('sync-error', state === 'error');
    if (state === 'syncing') {
      refreshBtn.title = 'Syncing';
      refreshBtn.setAttribute('aria-label', 'Syncing');
      refreshBtn.setAttribute('aria-busy', 'true');
    } else if (state === 'error') {
      refreshBtn.title = 'Sync failed — refresh to retry';
      refreshBtn.setAttribute('aria-label', 'Sync failed — refresh to retry');
      refreshBtn.removeAttribute('aria-busy');
    } else {
      refreshBtn.title = 'Synced — refresh';
      refreshBtn.setAttribute('aria-label', 'Synced — refresh');
      refreshBtn.removeAttribute('aria-busy');
    }
  }

  function autoGrow(): void {
    const style = getComputedStyle(inputEl);
    const maxHeight =
      parseFloat(style.lineHeight) * MAX_INPUT_LINES +
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom);
    inputEl.style.height = 'auto';
    inputEl.style.overflowY = 'hidden';
    const height = Math.min(inputEl.scrollHeight, maxHeight);
    inputEl.style.height = `${height}px`;
    inputEl.style.overflowY = inputEl.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function renderChips(): void {
    chipsEl.hidden = pendingFiles.length === 0;
    chipsEl.innerHTML = pendingFiles
      .map(
        (f, i) => `
        <span class="composer-chip">
          <span class="composer-chip-glyph">${iconFile('0.9em')}</span>
          <span class="composer-chip-name">${escapeHtml(f.name)}</span>
          <span class="composer-chip-size">${formatBytes(f.size)}</span>
          <button class="composer-chip-remove" data-index="${i}" title="Remove" aria-label="Remove ${escapeHtml(f.name)}">${iconClose('0.85em')}</button>
        </span>`,
      )
      .join('');
  }

  chipsEl.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.composer-chip-remove');
    if (!btn) return;
    pendingFiles.splice(Number(btn.dataset.index), 1);
    renderChips();
  });

  function addFiles(files: File[]): void {
    for (const f of files) {
      if (f.size > MAX_ATTACH_BYTES) {
        onOversize(f.name);
        continue;
      }
      pendingFiles.push(f);
    }
    renderChips();
  }

  function send(): void {
    const text = inputEl.value.trim();
    if (!text && pendingFiles.length === 0) return;
    onSend(text, pendingFiles);
    inputEl.value = '';
    pendingFiles = [];
    renderChips();
    autoGrow();
    inputEl.focus();
  }

  sendBtn.addEventListener('click', send);
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await onRefresh();
    } finally {
      refreshBtn.disabled = false;
    }
  });
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', e => {
    // Enter sends on desktop; Shift+Enter inserts a newline. On touch
    // keyboards Enter just newlines — the send button is the affordance.
    if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice()) {
      e.preventDefault();
      send();
    }
  });

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files) addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  // Paste: clipboard files (screenshots) become attachments
  const onPaste = (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      addFiles([...files]);
      inputEl.focus();
    }
  };
  document.addEventListener('paste', onPaste);

  // Drag-drop: full-viewport overlay
  let dragDepth = 0;
  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    dragOverlay.hidden = false;
  };
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragOverlay.hidden = true;
  };
  const onDrop = (e: DragEvent) => {
    dragDepth = 0;
    dragOverlay.hidden = true;
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  };
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
  autoGrow();

  return {
    setText(text: string) {
      inputEl.value = text;
      autoGrow();
    },
    addFiles,
    focus: () => inputEl.focus(),
    setSyncState,
    teardown() {
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    },
  };
}

function isTouchDevice(): boolean {
  // Coarse pointer alone misfires on touch-screen laptops; requiring
  // hover:none limits newline-Enter to true touch-first devices.
  return matchMedia('(hover: none) and (pointer: coarse)').matches;
}
