# LootGoblin

Self-hosted data-collection pipeline. Tag items as you browse, and LootGoblin scrapes, packages, and writes them to your library.

First-class target for v1: scraping free 3D models from **MakerWorld** into a **Manyfold**-compatible filesystem library. Pluggable architecture supports additional sources, packagers, and destinations — Patreon, MyMiniFactory, Swisstransfer, Google Drive, Reddit, Discord, YouTube, blogs, and more are on the roadmap.

```
┌──────────────────┐   tag    ┌────────────────────┐   scrape   ┌────────────────┐
│ Your real browser│ ───────▶ │ LootGoblin server  │ ─────────▶ │ Your library   │
│ (+ extension)    │  share   │ (Next.js, Docker)  │   package  │ (filesystem,   │
│                  │  cookies │ queue + workers    │   atomic   │  Manyfold, …)  │
└──────────────────┘          └────────────────────┘            └────────────────┘
```

## Install

### Docker Compose

```bash
curl -O https://raw.githubusercontent.com/gavinmcfall/lootgoblin/main/docker-compose.yml
echo "LOOTGOBLIN_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
# open http://localhost:7393
```

Full docs: **[docs/deployment/docker.md](docs/deployment/docker.md)**

### Kubernetes (bjw-s/helm-charts app-template)

Reference values at **[docs/deployment/k8s/values.example.yaml](docs/deployment/k8s/values.example.yaml)**. Full install walk-through: **[docs/deployment/k8s.md](docs/deployment/k8s.md)**.

### Courier (remote-LAN printers)

Printers on a different LAN from your server? Run the Courier agent on a local box. Full install walk-through: **[docs/deployment/courier.md](docs/deployment/courier.md)**.

### Browser extension

Install from Chrome Web Store / Firefox AMO once published, or sideload from [GitHub Releases](../../releases). Install walk-through: **[apps/extension/README.md](apps/extension/README.md)**.

## First-run

1. Open LootGoblin (`http://localhost:7393` by default).
2. **Admin setup** — pick a username + password (≥ 12 chars).
3. **First library** — a filesystem destination with a naming template (default: `{designer}/{title}`).
4. **Extension pair** — install the browser extension, enter your server URL in its popup, approve the 6-digit code in Settings → Extensions.
5. Browse a supported site, share your session once from the extension popup, click **🎯 Tag** on items you want, hit **▶ Go** in the LootGoblin UI.

## Develop

```bash
# One-time — export a stable secret so sessions + encrypted credentials
# persist across dev-server restarts.
export LOOTGOBLIN_SECRET=$(openssl rand -hex 32)

# Run the server
npm install
npm run dev --workspace=server      # http://localhost:7393

# In another terminal — build + sideload the extension
npm run build --workspace=extension  # Chrome MV3
npm run build:firefox --workspace=extension

# Tests
npm run test       # server + extension unit/integration
cd apps/server && npx playwright test  # E2E first-run wizard
```

Requires Node 22+.

## License

MIT.
