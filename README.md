# Milkbox

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
  resumably in 10 MiB chunks when large. A folder-cTag check makes the
  steady-state poll one tiny GET.
- **Offline-first.** The feed renders from IndexedDB instantly; sends queue
  in a persistent outbox that survives reloads and drains on reconnect.
- **Installable PWA** with Web Share Target support — share text, links, or
  photos into Milkbox from any app's share sheet.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run preview    # serve the built app (service worker active)
```

Auth requires an Azure app registration (SPA platform, personal Microsoft
accounts, redirect URIs `http://localhost:5173/` and the production origin);
its client ID goes in `src/services/auth-config.ts`.

## Stack

Vanilla TypeScript + Vite + vite-plugin-pwa. The only runtime dependency is
`@azure/msal-browser`. Fonts are self-hosted Schibsted Grotesk and Commit
Mono (both SIL OFL — license texts ship in `public/fonts/`).
