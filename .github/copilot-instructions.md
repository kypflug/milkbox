# Milkbox review guidance

- Preserve the privacy boundary: Milkbox is a static client and may access only
  the signed-in user's OneDrive App Folder through
  `Files.ReadWrite.AppFolder`. Never add service credentials or broader Graph
  scopes.
- Keep drop JSON backward compatible. Existing records may not have a device
  ID, file metadata, or fields introduced by newer clients.
- Preserve offline-first behavior. Mutations must survive reloads in the
  persistent outbox, and optional metadata/profile sync must not block drop
  delivery.
- Keep sync passes serialized. A mutation queued during a pass must trigger a
  follow-up drain rather than waiting for the polling interval.
- Use strict TypeScript without `any` casts or swallowed errors. Follow the
  repository's targeted error handling and existing IndexedDB/Graph helpers.
- Maintain both full-bleed and floating-pane layouts at the 800px by 600px
  breakpoint. In Window Controls Overlay mode, keep window dragging isolated
  to the empty `.window-drag-region`; do not compose nested drag/no-drag
  regions. The full visible titlebar must stay draggable, interactive content
  must remain outside that overlay, and chrome colors must match the active
  background.
- Keep service-worker changes compatible with the custom `injectManifest`
  build and Web Share Target flow.
- Treat `src/styles/global.css` as the only source of truth for colour, and
  mirror any change into the copies that are not built from it: the
  `theme-color` meta and pre-CSS theme stamp in `index.html`, the manifest
  `theme_color`/`background_color` in `vite.config.ts`, the always-dark
  lightbox scrim in `feed.css`, the inlined tokens in `art/`, the icon
  background in `scripts/generate-images.ts`, and `accent` in stuntcamp's
  registry entry. Recompute the WCAG 4.5:1 ratios recorded in `global.css`
  instead of carrying the old numbers over.
- Regenerate brand assets in the same release as a visual change:
  `npm run img:generate` for icons, and re-render `public/og.png` plus the
  stuntcamp hub card from `art/social-card.html`. The hub card is a curated
  override, not an autocapture — stuntcamp screenshots the live site signed
  out, so it can only reach the sign-in screen. See the README for sizes.
- Deployment pins a full commit SHA in stuntcamp's
  `registry/apps/milkbox.json`; never a branch or short SHA.
- Validate changes with `npm run build`. Do not add dependencies or tooling
  without a concrete need.
