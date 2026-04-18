# LootGoblin extension

Browser extension for the [LootGoblin](../../) self-hosted data-collection pipeline. Pairs with your LootGoblin server and injects tag buttons on supported sites so you can queue items as you browse.

## Install

### From a store (once published)
- **Chrome / Edge / Opera:** Chrome Web Store — *link pending*
- **Firefox:** addons.mozilla.org — *link pending*

### Sideload from GitHub Releases
Every tagged extension release ships the packaged zips + an AMO-compliant source zip + checksums on the GitHub Releases page.

- **Chrome / Edge / Opera:** download `lootgoblin-chrome-<version>.zip`, unzip, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, point at the unzipped directory.
- **Firefox:** download `lootgoblin-firefox-<version>.zip`, open `about:debugging` → **This Firefox** → **Load Temporary Add-on** → pick the zip's `manifest.json` (Firefox installs temporary extensions until browser restart).
- **Edge-optimized build:** `lootgoblin-edge-<version>.zip`, install via `edge://extensions` Developer mode.

Verify integrity with `sha256sum -c SHA256SUMS` from the release page.

## Pair the extension with your server

1. Run the LootGoblin server (see the [server README](../server/) — quickest path is `docker compose up`).
2. Open the extension popup (click the LootGoblin icon in the toolbar).
3. Enter your server URL (e.g. `http://lootgoblin.lan:7393`) and click **Pair**.
4. A six-digit code appears in the popup.
5. In the LootGoblin web UI, go to **Settings → Extensions**, find the pending pairing request, and click **Approve**.
6. The popup flips to the paired status view within a second or two.

## Share a session

Each source (e.g. MakerWorld) needs your authenticated cookies to fetch metadata + files on your behalf.

1. On a supported site (MakerWorld, etc.), sign in as you normally would.
2. Open the extension popup. It detects the active tab's site and shows any existing credentials for it.
3. Click **Share session** (or **Re-share session** if you need to refresh expired cookies).
4. The extension reads the site's cookies and securely sends them to your server, which encrypts them at rest with `LOOTGOBLIN_SECRET`.

Credentials are per-site, not per-tab — you only need to share once until they expire.

## Tag an item

On a supported site, a small **Tag** button appears on each recognized item (e.g. model tiles on MakerWorld). Click to queue the item. LootGoblin's server-side worker then picks it up and scrapes it into your configured library.

If an item has already been scraped, the extension flashes *"already in library"* instead of re-queuing.

## Build from source

See [`BUILD.md`](BUILD.md). Short version:

```bash
# From repo root
npm install
npm run build --workspace=extension            # Chrome MV3
npm run build:firefox --workspace=extension    # Firefox MV2
npm run build:edge --workspace=extension       # Edge MV3
```

Output lands in `apps/extension/.output/<target>/`.

## Release

Extension releases are tagged `extension-v<version>` and triggered from the `apps/extension/` directory:

```bash
cd apps/extension
npm run release:patch   # or release:minor / release:major
git push --tags
```

The tag-push fires CI which builds all browser targets, produces the Firefox AMO source zip, writes `SHA256SUMS`, and attaches everything to a GitHub Release.

## License

MIT.
