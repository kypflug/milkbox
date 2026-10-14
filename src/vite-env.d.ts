/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Window Controls Overlay. Not in TypeScript's DOM lib yet, so the slice we
 * use is declared here rather than reached for through an `any` cast.
 */
interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

interface Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlay;
}
