/**
 * Link detection and metadata. Titles are not fetched (CORS makes that a
 * server problem) — a link drop shows its domain in mono, plus the shared
 * title when the share sheet provided one.
 */

/** True if the string is a single bare URL and nothing else. */
export function isBareUrl(text: string): boolean {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Favicon URL for a domain — cached by the service worker (CacheFirst). */
export function faviconUrl(domain: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
}

/** Extract the first http(s) URL found in free text, if any. */
export function firstUrlIn(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}
