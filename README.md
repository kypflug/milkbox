# Milkbox

[![CI](https://github.com/kypflug/milkbox/actions/workflows/ci.yml/badge.svg)](https://github.com/kypflug/milkbox/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A chat with yourself. Drop text, links, files, and photos; they land on every
device you sign in on — like leaving something in the milkbox on a neighbor's
stoop.

A lightweight replacement for the deprecated Microsoft Edge "Drop" feature,
built as an installable PWA. Live at [milkbox.stuntcamp.app](https://milkbox.stuntcamp.app).

## How it works

- **Sign in with your Microsoft account.** Milkbox stores everything in a
  private app folder in *your* OneDrive (`Apps/Milkbox`) via Microsoft Graph
  with the minimal `Files.ReadWrite.AppFolder` scope. There is no server —
  the app is static files; your data never transits anything else.
- **Each drop is a tiny JSON** (`drops/<ulid>.json`) tracked by the Graph
  delta API; file payloads live beside them (`files/<ulid>/…`), uploaded
  resumably in 10 MiB chunks when large. Device profiles live separately in
  `devices/<id>.json`, so renames update historical attribution without
  rewriting drops. Folder-cTag checks keep steady-state polling small.
- **Offline-first.** The feed renders from IndexedDB instantly; sends queue
  in a persistent outbox that survives reloads and drains on reconnect.
- **Installable PWA** with Web Share Target support — share text, links, or
  photos into Milkbox from any app's share sheet.

## Development

```bash
npm ci
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run preview    # serve the built app (service worker active)
```

Auth requires an Azure app registration (SPA platform, personal Microsoft
accounts, redirect URIs `http://localhost:5173/` and the production origin);
its client ID goes in `src/services/auth-config.ts`.

## Deployment

Production is built by [`kypflug/stuntcamp`](https://github.com/kypflug/stuntcamp)
from a pinned Milkbox commit, so nothing ships until that pin moves.

1. Merge the release here and take the **full** commit SHA of `main`.
2. If the release changed the look, regenerate the brand assets first — see
   below. They are committed, not built, so they do not follow automatically.
3. Open a stuntcamp pull request updating `registry/apps/milkbox.json`:
   - `build.ref` — the full SHA. Not a branch or short SHA; pinning keeps the
     published source explicit and reproducible.
   - `accent` — the light-theme `--accent`, if the palette moved.
   - `thumbnail` — the refreshed hub card, if the look changed.
4. stuntcamp's `validate` workflow clones and builds the pinned ref. Merging
   `main` there deploys.

### Regenerating brand assets

```bash
npm run img:generate   # app icons + favicon-32, from art/icon-master.svg
```

The two captures come from `art/social-card.html`, which reads `?theme=dark`
and `?size=og`. Any headless Chromium works. Load it over `file://` so its
relative font paths resolve. The sizes matter — they are declared in metadata
and in the hub's responsive ladder:

| Output | Query | Viewport | Result |
| --- | --- | --- | --- |
| `public/og.png` | `?size=og` | 1200x630 @2x | 2400x1260, matching `og:image:width`/`height` in `index.html` |
| hub card, light | *(none)* | 1280x800 @2x | 2560x1600 |
| hub card, dark | `?theme=dark` | 1280x800 @2x | 2560x1600 |

The hub card is a **curated override**, pinned by `thumbnail` in the registry,
and must be refreshed in the deployment pull request. stuntcamp's post-deploy
autocapture cannot stand in for it: that job screenshots the live site signed
out, so it only ever reaches the sign-in screen.

### Colours live in more than one place

`src/styles/global.css` is the source of truth. These copies are not built
from it and drift silently, so a palette change has to update all of them:

- `index.html` — `<meta name="theme-color">` and the pre-CSS theme stamp
  (`full` = `--ground`, `pane` = `--desk`, per theme)
- `vite.config.ts` — manifest `theme_color` (`--ground`) and
  `background_color` (`--surface`)
- `src/styles/feed.css` — the lightbox scrim and caption, which stay dark in
  both themes
- `art/icon-master.svg`, `art/social-card.html` — inlined so they render
  standalone
- `scripts/generate-images.ts` — the icon background
- stuntcamp's `registry/apps/milkbox.json` — `accent`

Ink and accent steps are held to WCAG 4.5:1 against `--surface`,
`--surface-sunk`, `--ground`, and `--accent-soft` in both themes; recompute
the ratios noted in `global.css` rather than carrying them over.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request
guidance. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Stack

Vanilla TypeScript + Vite + vite-plugin-pwa. The only runtime dependency is
`@azure/msal-browser`. Fonts are self-hosted Schibsted Grotesk and Commit
Mono (both SIL OFL — license texts ship in `public/fonts/`).
