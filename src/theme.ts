import type { Theme } from './types';
import { safeGetItem, safeSetItem } from './utils/storage';

const THEME_KEY = 'milkbox:theme';
const PANE_QUERY = '(min-height: 600px) and (min-width: 800px)';

export function getTheme(): Theme {
  const t = safeGetItem(THEME_KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

/**
 * Apply the current theme (from storage or system default) by stamping
 * data-theme on the root element — the same attribute the inline head
 * script sets before CSS loads.
 */
export function applyTheme(theme?: Theme): void {
  const t = theme ?? getTheme();
  const resolved =
    t === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : t;

  document.documentElement.setAttribute('data-theme', resolved);

  if (theme) safeSetItem(THEME_KEY, theme);

  updateChromeColor();
}

function updateChromeColor(): void {
  const metaEl = document.querySelector('meta[name="theme-color"]');
  if (!metaEl) return;
  metaEl.setAttribute('content', getComputedStyle(document.body).backgroundColor);
}

// Follow system theme changes when set to 'system'
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getTheme() === 'system') applyTheme();
});

matchMedia(PANE_QUERY).addEventListener('change', updateChromeColor);
