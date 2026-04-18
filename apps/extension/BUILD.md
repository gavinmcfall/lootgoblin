# Build Instructions

## Requirements
- Node.js v22+
- npm v10+

## Steps
From repo root:
```bash
npm install
npm run build:firefox --workspace=extension
```
Output: `apps/extension/.output/firefox-mv2/`.

## Tools
- WXT (wxt.dev) — extension framework
- Vite — bundler
- TypeScript

No globally installed tools are required.
