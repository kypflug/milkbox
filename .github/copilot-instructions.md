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
  breakpoint. In Window Controls Overlay mode, interactive controls must be
  `no-drag`, the remaining titlebar must stay draggable, and chrome colors must
  match the active background.
- Keep service-worker changes compatible with the custom `injectManifest`
  build and Web Share Target flow.
- Validate changes with `npm run build`. Do not add dependencies or tooling
  without a concrete need.
