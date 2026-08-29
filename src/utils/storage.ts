/**
 * Safe localStorage wrappers for Safari Private Browsing and iOS.
 * These functions catch exceptions thrown by localStorage access and fail silently.
 */

export function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Silent fail on Safari Private Browsing
  }
}

export function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Silent fail on Safari Private Browsing
  }
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape a string for a double-quoted HTML attribute position.
 * escapeHtml goes through textContent, which leaves quotes intact — safe for
 * element bodies, attribute-injectable in href/title/etc. Apply this on top.
 */
export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
