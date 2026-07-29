import { safeGetItem, safeSetItem } from '../utils/storage';

const DEVICE_NAME_KEY = 'milkbox:device-name';

/** Best-effort OS label from the UA — used as attribution, not detection. */
export function detectOs(): string {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'iPadOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Web';
}

function defaultDeviceName(): string {
  const os = detectOs();
  switch (os) {
    case 'iOS': return 'iPhone';
    case 'iPadOS': return 'iPad';
    case 'Android': return 'Android phone';
    case 'macOS': return 'Mac';
    case 'Windows': return 'Windows PC';
    default: return 'Browser';
  }
}

export function getDeviceName(): string {
  return safeGetItem(DEVICE_NAME_KEY) || defaultDeviceName();
}

export function setDeviceName(name: string): void {
  safeSetItem(DEVICE_NAME_KEY, name.trim());
}

export function getDeviceInfo(): { name: string; os: string } {
  return { name: getDeviceName(), os: detectOs() };
}
