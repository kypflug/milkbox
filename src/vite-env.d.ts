/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Window Controls Overlay. Not in TypeScript's DOM lib yet, so the slice we
 * use is declared here rather than reached for through an `any` cast.
 */
interface WindowControlsOverlayGeometryChangeEvent extends Event {
  readonly titlebarAreaRect: DOMRect;
  readonly visible: boolean;
}

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(
    type: 'geometrychange',
    listener: (event: WindowControlsOverlayGeometryChangeEvent) => void,
  ): void;
  removeEventListener(
    type: 'geometrychange',
    listener: (event: WindowControlsOverlayGeometryChangeEvent) => void,
  ): void;
}

interface Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlay;
}
