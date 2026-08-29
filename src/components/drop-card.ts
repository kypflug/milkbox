import type { DropRecord } from '../types';
import { escapeAttr, escapeHtml } from '../utils/storage';
import { formatBytes, formatTime } from '../utils/format';
import { domainOf, faviconUrl } from '../services/link-meta';
import { iconFile, iconLink, iconCopy, iconDownload, iconEdit, iconTrash, iconRetry, iconClose } from './icons';

export interface DropCardPresentation {
  side: 'sent' | 'received';
  deviceLabel: string;
}

/** Linkify bare URLs inside already-escaped text. */
function linkify(escaped: string): string {
  return escaped.replace(
    /https?:\/\/[^\s<]+/g,
    // The match is already HTML-escaped text, but quotes survive escapeHtml
    // and would break out of the href attribute.
    url => `<a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
}

function metaLine(record: DropRecord, deviceLabel: string): string {
  const { meta, state } = record;
  const time = formatTime(meta.createdAt);
  const device = escapeHtml(deviceLabel);
  const edited = meta.editedAt ? ' · EDITED' : '';
  const status =
    state === 'sending' ? ' · SENDING' : state === 'failed' ? ' · FAILED' : '';
  return `<div class="drop-meta">${time} · ${device}${edited}${status}</div>`;
}

function actionsRow(record: DropRecord): string {
  const { meta, state } = record;
  if (state === 'failed') {
    return `
      <div class="drop-actions" role="toolbar" aria-label="Drop actions">
        <button class="drop-action" data-action="retry" title="Retry send">${iconRetry()}</button>
        <button class="drop-action drop-action-danger" data-action="discard" title="Discard">${iconClose()}</button>
      </div>`;
  }
  const buttons: string[] = [];
  if (meta.kind === 'text' || meta.kind === 'link') {
    buttons.push(`<button class="drop-action" data-action="copy" title="Copy">${iconCopy()}</button>`);
  }
  if (meta.kind === 'file' || meta.kind === 'image') {
    buttons.push(`<button class="drop-action" data-action="download" title="Download">${iconDownload()}</button>`);
  }
  if (meta.kind === 'text' && !state) {
    buttons.push(`<button class="drop-action" data-action="edit" title="Edit">${iconEdit()}</button>`);
  }
  buttons.push(`<button class="drop-action drop-action-danger" data-action="delete" title="Delete">${iconTrash()}</button>`);
  return `<div class="drop-actions" role="toolbar" aria-label="Drop actions">${buttons.join('')}</div>`;
}

function bodyFor(record: DropRecord): string {
  const { meta } = record;
  switch (meta.kind) {
    case 'text':
      return `<div class="drop-text">${linkify(escapeHtml(meta.text || ''))}</div>`;

    case 'link': {
      const url = meta.url || '';
      // Remote drop JSON goes through the ingest validator, but keep the
      // protocol check here too — an href must never carry javascript: etc.
      const href = /^https?:\/\//i.test(url) ? url : 'about:blank';
      const domain = meta.link?.domain || domainOf(url);
      const title = meta.link?.title;
      return `
        <a class="drop-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">
          <span class="drop-link-favicon-frame">${iconLink('0.9em')}<img class="drop-link-favicon" src="${escapeAttr(faviconUrl(domain))}" alt="" loading="lazy"></span>
          <span class="drop-link-body">
            <span class="drop-link-title">${escapeHtml(title || url)}</span>
            <span class="drop-link-domain">${escapeHtml(domain)}</span>
          </span>
        </a>`;
    }

    case 'image': {
      const f = meta.file;
      const ratio = f?.width && f?.height ? `aspect-ratio: ${f.width} / ${f.height};` : '';
      const caption = meta.text
        ? `<div class="drop-text drop-caption">${linkify(escapeHtml(meta.text))}</div>`
        : '';
      return `
        <button class="drop-image" data-action="lightbox" style="${ratio}" title="${escapeAttr(f?.name || 'Image')}">
          <img data-thumb-id="${escapeAttr(meta.id)}" alt="${escapeAttr(f?.name || 'Image')}" loading="lazy">
          <span class="drop-image-progress" hidden><span class="drop-image-progress-fill"></span></span>
        </button>
        ${caption}`;
    }

    case 'file': {
      const f = meta.file;
      const caption = meta.text
        ? `<div class="drop-text drop-caption">${linkify(escapeHtml(meta.text))}</div>`
        : '';
      return `
        <button class="drop-file" data-action="download">
          <span class="drop-file-glyph">${iconFile('1.4em')}</span>
          <span class="drop-file-body">
            <span class="drop-file-name">${escapeHtml(f?.name || 'File')}</span>
            <span class="drop-file-size">${f ? formatBytes(f.size) : ''}</span>
          </span>
        </button>
        ${caption}`;
    }
  }
}

/** One feed card. The container carries data-drop-id for event delegation. */
export function renderDropCard(
  record: DropRecord,
  presentation: DropCardPresentation,
): string {
  const { meta, state } = record;
  const stateClass = state ? ` drop-card--${state}` : '';
  return `
    <article class="drop-card drop-card--${meta.kind} drop-card--${presentation.side}${stateClass}" data-drop-id="${escapeAttr(meta.id)}">
      ${bodyFor(record)}
      ${metaLine(record, presentation.deviceLabel)}
      ${actionsRow(record)}
    </article>
  `;
}
