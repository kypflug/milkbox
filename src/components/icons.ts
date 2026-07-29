/**
 * Inline SVG icons — stroke: currentColor, sized in em. No icon library;
 * the family rule is that every glyph ships inline.
 */

const svg = (body: string, size = '1em') =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Milk bottle — the wordmark glyph. */
export const iconBottle = (size = '1em') =>
  svg('<path d="M9 3h6M9.5 3v3l-2 3.5V19a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V9.5l-2-3.5V3"/><path d="M7.5 13h9"/>', size);

export const iconSend = (size = '1em') =>
  svg('<path d="M4 12 20 4l-4 16-5.2-5.2L4 12Z"/><path d="M10.8 14.8 20 4"/>', size);

export const iconAttach = (size = '1em') =>
  svg('<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 6"/>', size);

export const iconSettings = (size = '1em') =>
  svg('<circle cx="12" cy="12" r="2.6"/><path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6"/>', size);

export const iconCopy = (size = '1em') =>
  svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>', size);

export const iconDownload = (size = '1em') =>
  svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19h14"/>', size);

export const iconTrash = (size = '1em') =>
  svg('<path d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12"/>', size);

export const iconEdit = (size = '1em') =>
  svg('<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="m14 7 3 3"/>', size);

export const iconFile = (size = '1em') =>
  svg('<path d="M6 3h8l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5"/>', size);

export const iconLink = (size = '1em') =>
  svg('<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1.5-1.5"/>', size);

export const iconRetry = (size = '1em') =>
  svg('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>', size);

export const iconClose = (size = '1em') =>
  svg('<path d="m6 6 12 12M18 6 6 18"/>', size);

export const iconSignOut = (size = '1em') =>
  svg('<path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/><path d="M17 8.5 20.5 12 17 15.5M20 12H10"/>', size);
