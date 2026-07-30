# Contributing to Milkbox

Focused bug fixes and improvements are welcome.

## Development

Use Node.js 22 or newer:

```bash
npm ci
npm run dev
npm run build
```

The production build performs the strict TypeScript check and generates the
PWA/service-worker output. Run it before opening a pull request.

## Pull requests

- Keep each pull request focused and explain user-visible behavior.
- Preserve backward compatibility with existing OneDrive drop records.
- Do not commit credentials, access tokens, private account data, or generated
  `dist/` output.
- Add dependencies only when the feature cannot reasonably use browser APIs or
  existing helpers.
- Report security issues through the private channel in
  [SECURITY.md](SECURITY.md), not a public pull request or issue.

Milkbox is deployed separately by `kypflug/stuntcamp`, which builds a pinned
Milkbox commit. After a Milkbox change merges, deployment requires a stuntcamp
pull request updating `registry/apps/milkbox.json`.
