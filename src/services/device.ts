import { safeGetItem, safeSetItem } from '../utils/storage';
import type { DeviceAttribution, DeviceProfile } from '../types';

const DEVICE_NAME_KEY = 'milkbox:device-name';
const DEVICE_ID_KEY = 'milkbox:device-id';
const DEVICE_CREATED_AT_KEY = 'milkbox:device-created-at';
const DEVICE_UPDATED_AT_KEY = 'milkbox:device-updated-at';

let runtimeDeviceId = '';
let runtimeCreatedAt = 0;
let runtimeUpdatedAt = 0;

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

function storedTimestamp(key: string, fallback: number): number {
  const value = Number(safeGetItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getDeviceId(): string {
  if (runtimeDeviceId) return runtimeDeviceId;
  runtimeDeviceId = safeGetItem(DEVICE_ID_KEY) || crypto.randomUUID();
  safeSetItem(DEVICE_ID_KEY, runtimeDeviceId);
  return runtimeDeviceId;
}

export function getDeviceProfile(): DeviceProfile {
  const now = Date.now();
  if (!runtimeCreatedAt) {
    runtimeCreatedAt = storedTimestamp(DEVICE_CREATED_AT_KEY, now);
    safeSetItem(DEVICE_CREATED_AT_KEY, String(runtimeCreatedAt));
  }
  runtimeUpdatedAt = storedTimestamp(
    DEVICE_UPDATED_AT_KEY,
    runtimeUpdatedAt || runtimeCreatedAt,
  );
  safeSetItem(DEVICE_UPDATED_AT_KEY, String(runtimeUpdatedAt));
  return {
    v: 1,
    id: getDeviceId(),
    name: getDeviceName(),
    os: detectOs(),
    createdAt: runtimeCreatedAt,
    updatedAt: runtimeUpdatedAt,
  };
}

export function setDeviceName(name: string): DeviceProfile {
  const normalized = name.trim() || defaultDeviceName();
  safeSetItem(DEVICE_NAME_KEY, normalized);
  runtimeUpdatedAt = Date.now();
  safeSetItem(DEVICE_UPDATED_AT_KEY, String(runtimeUpdatedAt));
  return getDeviceProfile();
}

export function getDeviceInfo(): DeviceAttribution {
  const profile = getDeviceProfile();
  return { id: profile.id, name: profile.name, os: profile.os };
}
