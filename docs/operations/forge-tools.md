# Forge tools — bundled binaries

The lootgoblin Docker image bakes two external tools that the Forge format converter shells out to:

| Tool | Purpose | Source | Version pinned by |
|------|---------|--------|---------------------|
| `7z` (p7zip-full) | Archive extraction (zip/rar/7z) | Debian apt | base image (`debian:bookworm-slim` / `node:22-bookworm-slim`) |
| `blender` | Mesh conversion (stl/obj/fbx/glb/3mf) | blender.org tarball | `ARG BLENDER_VERSION` in `Dockerfile` |

The build stage stays on `node:22-alpine` (musl, fast). The `forge-tools` stage and the runtime stage are both on Debian (`bookworm-slim`) because Blender ships a glibc binary and the musl + `gcompat` shim path is unreliable for graphical libraries.

## Image size impact

Blender adds roughly 500 MB to the runtime image (extracted tarball + ~20 MB of X11/GL runtime libs). If your deployment doesn't need mesh conversion (e.g. it only ingests stl/obj/3mf and doesn't need to convert between them, or only does archive extraction), set `FORGE_DISABLE_MESH_CONVERSION=1` in the runtime env. The image still bundles Blender; the env var just causes the converter to skip Blender invocations gracefully — mesh-pair conversions return `{ok: false, reason: 'disabled-by-config', details: 'Mesh conversion disabled via FORGE_DISABLE_MESH_CONVERSION=1'}`.

For truly slim deployments, build a separate variant of the Dockerfile without the `forge-tools` stage (and skip the runtime-stage Blender copy + library install). This is a future enhancement; not yet provided.

## Bumping versions

### Blender

The `ARG BLENDER_VERSION` at the top of `Dockerfile` pins the version. Renovate is configured (`renovate.json`, `customManagers[1]`) to detect upstream releases via the `blender/blender` GitHub releases datasource and open a PR to bump the pin.

**Caveat:** Blender's canonical release channel is `https://download.blender.org/release/`, not GitHub. The `blender/blender` repo is a mirror that may or may not publish semver-tagged GitHub releases consistently. If Renovate fails to find versions, the regex manager will simply not open a PR — there is no false-positive risk. Fall back to the manual procedure below.

Manual bump:

1. Confirm the new version exists at `https://download.blender.org/release/Blender<MAJOR.MINOR>/blender-<VERSION>-linux-x64.tar.xz`
2. Edit `Dockerfile` → `ARG BLENDER_VERSION=<new>`
3. Build + smoke-test locally: `docker build .` (the build runs `blender --version` as a layer; a missing/broken download fails the build)
4. Open a PR

### 7z

Bumps with the base image. When Renovate bumps `node:22-bookworm-slim` (runtime) or `debian:bookworm-slim` (forge-tools), the apt-installed `p7zip-full` version follows. No separate version pin.

## Local development (non-Docker)

If running outside Docker (e.g. `npm run dev`), the Forge converter expects `7z` and `blender` on `PATH`:

- **macOS:** `brew install sevenzip blender`
- **Ubuntu/Debian:** `apt install p7zip-full blender`
- **Arch:** `pacman -S p7zip blender`

If a tool is missing at runtime, the converter returns `{ok: false, reason: 'missing-tool', toolName: '<name>', installHint: '<platform-specific>'}` — the API surfaces this to the user.

## Health check

The Docker build runs `7z --help` and `blender --version` as build-layer assertions in both the `forge-tools` stage and the final `runtime` stage. If a binary is missing or broken, the image build fails — you catch the problem before deploy. If you customize the Dockerfile, preserve these checks.

## Slicer install (V2-005c)

Slicers are NOT baked into the image. Install at runtime via the admin HTTP API:

```
POST /api/v1/forge/tools/prusaslicer/install
POST /api/v1/forge/tools/orcaslicer/install
POST /api/v1/forge/tools/bambustudio/install
```

Each route is admin-only and kicks off a background download + verify + extract pipeline. The response is `202 Accepted` with the install row's initial state; poll `GET /api/v1/forge/tools` until `installStatus='ready'`.

Binaries land in `/data/forge-tools/<slicer>/<version>/` by default. Override the install root with `FORGE_TOOLS_ROOT`. Removal goes through `DELETE /api/v1/forge/tools/<slicer>/uninstall` — best-effort `rm -rf` of the install root + DB row delete.

### Update checks

`GET /api/v1/forge/tools` surfaces `update_available=true` whenever the upstream version is newer than `installed_version`. The check runs:

- on server boot (one-shot) and
- nightly (background loop)

Both paths short-circuit when `FORGE_DISABLE_SLICER_AUTOUPDATE=1` is set. To pull a new version, `POST /api/v1/forge/tools/<slicer>/update` (re-runs the install pipeline against the latest release).

### Disable env vars

| Env var | Effect |
|---|---|
| `FORGE_DISABLE_SLICING=1` | The slicer worker becomes a no-op. Jobs in `slicing` stay parked until the flag clears. |
| `FORGE_DISABLE_SLICER_AUTOUPDATE=1` | Boot + nightly update checker is a no-op. Manual `POST /update` still works. |

## Slicer profile materialization

Grimoire `slicer_profiles` rows hold opaque slicer-config JSON. Before slicing, the worker materializes them onto disk at:

```
<LOOTGOBLIN_DATA_ROOT or /data>/forge-slicer-configs/<profile-id>/<slicer-kind>.ini
```

One file per `(profile, slicer-kind)` pair, tracked by the `forge_slicer_profile_materializations` table.

### Drift detection

When a Grimoire profile is updated, the materializer hashes the new `settingsPayload` and compares against the recorded `source_profile_hash`. On drift it sets `sync_required=true`; the next `getMaterializedConfigPath` call rewrites the file and clears the flag. Operators don't need to do anything — the sync happens lazily on the next slice.

## Slicer worker (V2-005c-T_c10)

The forge-slicer-worker drains `dispatch_jobs WHERE status='slicing'`. For each job it:

1. Resolves the input file (the converted-file derivative when present, else the loot's primary file).
2. Maps the target printer's `kind` to a Prusa-fork slicer:
   - `fdm_klipper` / `fdm_octoprint` → `prusaslicer`
   - `fdm_bambu_lan` → `bambustudio`
   - resin printers → fail with `unsupported-format`
3. Materializes the user's slicer profile (see above).
4. Invokes the slicer adapter (`--slice <input> --load <config> --output <dir>`).
5. On success: copies the produced gcode to `<DATA_ROOT>/forge-artifacts/<dispatch-job-id>/`, inserts a `forge_artifacts` row with `kind='gcode'`, and transitions the job to `claimable`.
6. On failure: maps adapter reasons to schema enum values:
   - `disabled-by-config` / `not-installed` / `binary-missing` → `unsupported-format`
   - `slicer-error` / `no-output` → `slicing-failed`
7. Cleans up the per-job temp output dir.

Concurrency is `1` by default (slicing is CPU-bound and minutes-scale). Override with `WORKER_FORGE_SLICER_CONCURRENCY` (clamped `[1, 4]`).

### Known limitation — slicer profile selection

`dispatch_jobs` does not currently carry a `slicer_profile_id` column. For the V2-005c MVP the worker picks the user's first `slicer_profiles` row (oldest by `created_at`). A future plan threads explicit profile selection through the dispatch route. Until then, multi-profile users should treat their oldest profile as the default.

## V2-005d-a: Moonraker (Klipper) dispatcher

### Configure a Klipper-based printer

1. POST /api/v1/forge/printers
   ```json
   {
     "kind": "fdm_klipper",
     "name": "Voron 2.4",
     "connectionConfig": {
       "host": "voron.lan",
       "port": 7125,
       "scheme": "http",
       "startPrint": true,
       "requiresAuth": true
     }
   }
   ```
2. POST /api/v1/forge/printers/:id/credentials
   ```json
   {
     "kind": "moonraker_api_key",
     "payload": { "apiKey": "<from Moonraker /access/api_key endpoint>" },
     "label": "Voron API key"
   }
   ```

### Connection config fields

- `host` (required) — printer hostname or IP
- `port` (default `7125`) — Moonraker port
- `scheme` (default `'http'`)
- `startPrint` (default `true`) — issue print start after upload (multipart `print=true`)
- `requiresAuth` (default `true`) — set `false` for trusted-IP setups (no `X-Api-Key` header sent)

### Security

Credentials are encrypted at rest with AES-256-GCM via `LOOTGOBLIN_SECRET`. The credential plaintext NEVER crosses the API surface — `GET /api/v1/forge/printers/:id/credentials` returns metadata only (`kind`, `label`, `lastUsedAt`).

ACL: per-printer credentials are owner-only. Admins do NOT bypass printer ACL — printers are personal devices in this consent model. To re-key an abandoned printer, delete and recreate the printer row (admin or new owner).

### Failure reasons surfaced on `dispatch_jobs.failure_reason`

| Adapter reason | Schema reason | Meaning |
|---|---|---|
| `unreachable` | `unreachable` | Network refused / unresolvable host |
| `auth-failed` | `auth-failed` | 401/403 from Moonraker (wrong API key) |
| `rejected` | `target-rejected` | 4xx with file rejected (mesh issue, permission) |
| `timeout` | `unreachable` | 60s upload timeout exceeded |
| `no-credentials` | `auth-failed` | `requiresAuth=true` but no creds row for printer |
| `unsupported-protocol` | `unsupported-format` | `printer.kind` has no registered handler |
| `unknown` | `unknown` | Catch-all (misconfig, decryption failure, etc.) |

The original adapter reason is preserved verbatim in `dispatch_jobs.failure_details` for diagnostic use.

### Real-printer smoke test

`apps/server/tests/integration/forge-moonraker-real.test.ts` skips unless these env vars are set:

```
LG_TEST_MOONRAKER_HOST=voron.lan
LG_TEST_MOONRAKER_API_KEY=<from /access/api_key>
LG_TEST_MOONRAKER_PORT=7125  # optional, default 7125
```

Operator runs `npx vitest run tests/integration/forge-moonraker-real.test.ts` with env vars set to validate against a real Klipper instance. Test uploads a no-op gcode (G28 + M84) with `startPrint=false`. Skipped in CI.

## V2-005d-d: OctoPrint dispatcher

### Configure an OctoPrint-based printer

1. POST /api/v1/forge/printers
   ```json
   {
     "kind": "fdm_octoprint",
     "name": "Prusa MK3S OctoPi",
     "connectionConfig": {
       "host": "octopi.lan",
       "port": 80,
       "scheme": "http",
       "apiPath": "/api",
       "select": true,
       "startPrint": true,
       "requiresAuth": true
     }
   }
   ```

2. POST /api/v1/forge/printers/:id/credentials
   ```json
   {
     "kind": "octoprint_api_key",
     "payload": { "apiKey": "<from OctoPrint Settings → API → Application Keys>" },
     "label": "Prusa MK3S API key"
   }
   ```

### Connection config fields

- `host` (required) — printer hostname or IP
- `port` (default `80`) — OctoPrint HTTP port. Common alternatives: `5000` (direct Flask), `8080` (Docker), custom for reverse-proxy
- `scheme` (default `'http'`) — set to `'https'` for TLS-fronted instances
- `apiPath` (default `/api`) — API prefix; override for reverse-proxy paths like `/octoprint/api`
- `select` (default `true`) — load uploaded file as the active print on the printer
- `startPrint` (default `true`) — start printing immediately after upload
- `requiresAuth` (default `true`) — set `false` for instances behind a separate auth layer (rare)

### Security

Credentials are encrypted at rest with AES-256-GCM via `LOOTGOBLIN_SECRET`. The credential plaintext NEVER crosses the API surface — `GET /api/v1/forge/printers/:id/credentials` returns metadata only (`kind`, `label`, `lastUsedAt`).

ACL: per-printer credentials are owner-only. Admins do NOT bypass printer ACL — printers are personal devices in this consent model. To re-key an abandoned printer, delete and recreate the printer row (admin or new owner).

### Failure reasons surfaced on `dispatch_jobs.failure_reason`

Identical mapping to Moonraker (see V2-005d-a section above):

| Adapter reason | Schema reason | OctoPrint-specific note |
|---|---|---|
| `unreachable` | `unreachable` | Network refused / DNS fail / TLS cert reject |
| `auth-failed` | `auth-failed` | API key wrong, expired, or lacks upload permission |
| `rejected` | `target-rejected` | OctoPrint refused: size limit, invalid gcode, disk full, missing slug |
| `timeout` | `unreachable` | 60s upload timeout |
| `no-credentials` | `auth-failed` | `requiresAuth=true` + no creds row |
| `unsupported-protocol` | `unsupported-format` | `printer.kind` has no registered handler |
| `unknown` | `unknown` | Catch-all (misconfig, decryption failure, 5xx) |

The original adapter reason is preserved verbatim in `dispatch_jobs.failure_details`.

### Real-printer smoke test

`apps/server/tests/integration/forge-octoprint-real.test.ts` skips unless these env vars are set:

```
LG_TEST_OCTOPRINT_HOST=octopi.lan
LG_TEST_OCTOPRINT_API_KEY=<from Settings → API → Application Keys>
LG_TEST_OCTOPRINT_PORT=80          # optional, default 80
LG_TEST_OCTOPRINT_API_PATH=/api    # optional, default /api
LG_TEST_OCTOPRINT_SCHEME=http      # optional, default http
```

Operator runs `npx vitest run tests/integration/forge-octoprint-real.test.ts` to validate against a real OctoPrint instance. Test uploads a no-op gcode (G28 + M84) with `select=false, startPrint=false`. Skipped in CI.

## V2-005d-b: Bambu LAN dispatcher

### One-time printer setup (REQUIRED)

Before lootgoblin can dispatch to a Bambu printer:

1. On the printer screen: **Settings → WLAN → LAN Mode** — toggle ON
2. **Settings → WLAN → LAN Mode → Developer Mode** — toggle ON ⚠️ **REQUIRED for firmware 01.08+**
3. Note the **Access Code** (8-character alphanumeric) and **Serial Number** shown on this screen

Without Developer Mode, firmware 01.08+ rejects MQTT print commands with "Connection refused: Not authorized" — the file uploads via FTP but the print never starts.

Required firmware versions for Developer Mode:
- X1C / X1E: ≥01.08.03.00
- P1S / P1P: ≥01.08.02.00
- A1 / A1 mini: ≥01.05.00.00
- H2 series + X2D + P2S: any current firmware (post-launch)

### Cloud co-existence

LAN mode does NOT replace cloud mode. The printer continues to talk to Bambu cloud — your Bambu Handy app keeps working unchanged. lootgoblin dispatches via the LAN side; cloud monitoring (video stream, remote status in lootgoblin's UI) is a separate future feature.

### Configure a Bambu printer in lootgoblin

1. POST /api/v1/forge/printers
   ```json
   {
     "kind": "bambu_h2c",
     "name": "Workshop H2C",
     "connectionConfig": {
       "ip": "192.168.1.42",
       "mqttPort": 8883,
       "ftpPort": 990,
       "startPrint": true,
       "forceAmsDisabled": false,
       "plateIndex": 1,
       "bedType": "auto",
       "bedLevelling": true,
       "flowCalibration": true,
       "vibrationCalibration": true,
       "layerInspect": false,
       "timelapse": false
     }
   }
   ```

   **Supported kinds** (one per Bambu printer model):
   - **H2 series** (multi-function): `bambu_h2d`, `bambu_h2d_pro`, `bambu_h2c`, `bambu_h2s`
   - **X series**: `bambu_x2d`
   - **P series**: `bambu_p2s`, `bambu_p1s`, `bambu_p1p`
   - **A series**: `bambu_a1`, `bambu_a1_mini`
   - **X1 series** (EOL 2026-03-31, still supported): `bambu_x1c`, `bambu_x1e`, `bambu_x1`

2. POST /api/v1/forge/printers/:id/credentials
   ```json
   {
     "kind": "bambu_lan",
     "payload": {
       "accessCode": "<from printer screen>",
       "serial": "<from printer screen>"
     },
     "label": "Workshop H2C"
   }
   ```

### Connection config fields

- `ip` (required) — printer IP on the LAN
- `mqttPort` (default 8883) — Bambu MQTT broker port
- `ftpPort` (default 990) — Bambu FTPS port (implicit TLS)
- `startPrint` (default true) — issue print start after upload
- `forceAmsDisabled` (default false) — disable AMS even if the .gcode.3mf has AMS metadata. Useful for single-color prints loaded into AMS slot 1.
- `plateIndex` (default 1) — which plate inside a multi-plate 3MF to print. Multi-plate 3MFs are V2-005d-b-CF-2 carry-forward; current default is 1.
- `bedType` (default 'auto') — overrides the build-plate type. Options: `auto`, `cool_plate`, `engineering_plate`, `high_temp_plate`, `textured_pei_plate`, `pei_plate`.
- `bedLevelling` (default true) — re-level the bed before printing (recommended).
- `flowCalibration` (default true) — flow rate calibration (recommended for new filament).
- `vibrationCalibration` (default true) — vibration calibration (recommended for first print on a new printer or after maintenance).
- `layerInspect` (default false) — AI-driven layer inspection (X1 series only; ignored on others).
- `timelapse` (default false) — record a timelapse during printing.

### File format

V2-005d-b accepts `.gcode.3mf` (or `.3mf`) produced by Bambu Studio (V2-005c). Plain `.gcode` is rejected — Bambu printers need the 3MF wrapper for AMS metadata, thumbnails, and slicer settings.

### AMS support

If the .gcode.3mf was sliced with AMS enabled in Bambu Studio, the adapter auto-extracts the slot mapping from `Metadata/slice_info.config` and passes it through to the printer. To force AMS off (e.g., loading a single color into AMS slot 1 and printing single-color), set `forceAmsDisabled: true` in connection-config.

### Security

Bambu printers self-sign their TLS certs for LAN mode. Both MQTT (port 8883) and FTPS (port 990) connections use `rejectUnauthorized: false`. This is universal community practice for Bambu LAN integrations. Acceptable for trusted home/office LAN; do NOT expose Bambu LAN ports to the internet.

Credentials encrypted at rest with AES-256-GCM via `LOOTGOBLIN_SECRET`. The credential plaintext NEVER crosses the API surface — `GET /api/v1/forge/printers/:id/credentials` returns metadata only (kind, label, lastUsedAt).

ACL: per-printer credentials are owner-only. Admins do NOT bypass printer ACL.

### Failure reasons surfaced on `dispatch_jobs.failure_reason`

| Adapter reason | Schema reason | Bambu-specific |
|---|---|---|
| `unreachable` | `unreachable` | Network refused / unresolvable; check printer IP, ensure on same LAN |
| `auth-failed` | `auth-failed` | Most common: (1) wrong access code, OR (2) **Developer Mode not enabled** — see one-time setup above |
| `rejected` | `target-rejected` | File rejected — wrong format (need .gcode.3mf), corrupt 3MF, disk full |
| `timeout` | `unreachable` | 90s upload timeout |
| `no-credentials` | `auth-failed` | No credentials row for this printer |
| `unsupported-protocol` | `unsupported-format` | `printer.kind` has no registered handler |
| `unknown` | `unknown` | Catch-all (misconfig, decryption failure, MQTT publish error) |

The original adapter reason is preserved verbatim in `dispatch_jobs.failure_details`.

### Real-printer smoke test

`apps/server/tests/integration/forge-bambu-real.test.ts` skips unless these env vars are set:

```
LG_TEST_BAMBU_IP=192.168.1.42
LG_TEST_BAMBU_ACCESS_CODE=<from printer screen>
LG_TEST_BAMBU_SERIAL=<from printer screen>
LG_TEST_BAMBU_KIND=bambu_p1s          # optional, default bambu_p1s
LG_TEST_BAMBU_MQTT_PORT=8883          # optional, default 8883
LG_TEST_BAMBU_FTP_PORT=990            # optional, default 990
```

Operator runs `npx vitest run tests/integration/forge-bambu-real.test.ts` to validate against a real Bambu printer. Test uploads a tiny no-op gcode (G28 + M84) wrapped in a single-color `.gcode.3mf` to `/cache/` with `startPrint=false`. Skipped in CI.

## V2-005d-c: Resin printer dispatchers

lootgoblin's Forge pillar supports two resin printer protocol families: **SDCP 3.0** (Elegoo Saturn 4+/Mars 5+) and **ChituBox legacy network sending** (Phrozen Sonic family + Uniformation GKtwo + legacy Elegoo with pre-SDCP firmware).

### Supported brands matrix

| Family | Brands / Models | Kind values |
|---|---|---|
| SDCP 3.0 | Elegoo Saturn 4 / 4 Ultra / 3 Ultra, Mars 5 / 5 Ultra (+ Tier 2: Mars 4 Ultra, Saturn 2, Mars 3 with legacy MQTT path) | `sdcp_elegoo_saturn_4`, `sdcp_elegoo_saturn_4_ultra`, `sdcp_elegoo_saturn_3_ultra`, `sdcp_elegoo_mars_5`, `sdcp_elegoo_mars_5_ultra`, `sdcp_elegoo_mars_4_ultra`, `sdcp_elegoo_saturn_2`, `sdcp_elegoo_mars_3` |
| ChituBox legacy network | Phrozen Sonic Mighty 8K, Mega 8K, Mini 8K; Uniformation GKtwo, GKone; Elegoo Mars/Saturn (pre-SDCP firmware) | `chitu_network_phrozen_sonic_mighty_8k`, `chitu_network_phrozen_sonic_mega_8k`, `chitu_network_phrozen_sonic_mini_8k`, `chitu_network_uniformation_gktwo`, `chitu_network_uniformation_gkone`, `chitu_network_elegoo_mars_legacy`, `chitu_network_elegoo_saturn_legacy` |

### Encrypted CTB requirement (CRITICAL)

**Phrozen Sonic 8K family + Uniformation GKtwo/GKone require ENCRYPTED CTB.** These printers ship with locked ChiTu mainboards that silently reject plain unencrypted CTB files. lootgoblin's V2-005c slicer pipeline (PrusaSlicer / OrcaSlicer / Bambu Studio) does NOT produce encrypted CTB.

**Workaround until V2-005d-c-CF-1 (Chitubox slicer integration)**:
1. Slice your STL externally in Chitubox Basic/Pro or Lychee Pro
2. Export the encrypted .ctb file
3. Upload it to lootgoblin as a Loot file (existing V2-003 upload route)
4. Dispatch via lootgoblin to your Phrozen / Uniformation printer

The ChituNetwork dispatcher detects unencrypted CTB at file-format-gate time and rejects with a clear operator message (failure_reason='target-rejected', failure_details mentions "encrypted CTB" + "Chitubox or Lychee Pro").

For SDCP 3.0 printers (Elegoo Saturn 4+, Mars 5+) — NO encryption required; any valid .ctb works.

### Configure an SDCP printer

POST /api/v1/forge/printers with:
```json
{
  "kind": "sdcp_elegoo_saturn_4_ultra",
  "name": "My Saturn 4 Ultra",
  "ownerId": "<user-id>",
  "connectionConfig": {
    "ip": "192.168.1.42",
    "mainboardId": "<from UDP discovery or printer info screen>",
    "port": 3030,
    "startPrint": true,
    "startLayer": 0
  }
}
```

Then POST credentials with empty payload (no auth at protocol level):
```
POST /api/v1/forge/printers/<id>/credentials
{ "kind": "sdcp_passcode", "payload": {} }
```

### Configure a ChituNetwork printer

POST /api/v1/forge/printers:
```json
{
  "kind": "chitu_network_phrozen_sonic_mighty_8k",
  "name": "Phrozen Sonic Mighty 8K",
  "connectionConfig": {
    "ip": "192.168.1.43",
    "port": 3000,
    "startPrint": true,
    "stageTimeoutMs": 60000
  }
}
```

Then POST credentials with empty payload (same as SDCP — no auth):
```
POST /api/v1/forge/printers/<id>/credentials
{ "kind": "sdcp_passcode", "payload": {} }
```

### Discovery

Both protocols broadcast on UDP port 3000 with the same `M99999` query — but reply formats differ (SDCP returns JSON, ChituNetwork returns ASCII). Use the unified discovery endpoint:

```
GET /api/v1/forge/discover-resin?timeoutMs=5000
```

Returns:
```json
{
  "sdcp": [
    { "id": "...", "mainboardId": "...", "mainboardIp": "...", "name": "...", "machineName": "Saturn 4 Ultra", ... }
  ],
  "chituNetwork": [
    { "name": "Phrozen Sonic Mighty 8K", "ip": "192.168.1.43" }
  ]
}
```

Operator picks from results, then POSTs to /api/v1/forge/printers with the IP (and MainboardID if SDCP) prefilled.

### Failure-reason mapping

Same shape as Moonraker/OctoPrint/Bambu — adapter-level reasons map to schema-level enum, original reason preserved in failure_details. ChituNetwork-specific:
- 'rejected' (file-format gate) → schema 'target-rejected' with details about CTB encryption
- 'rejected' (M28) → schema 'target-rejected' with stage prefix
- 'unreachable' (TCP refused) → schema 'unreachable'
- 'timeout' (per-stage timeout) → schema 'timeout-error' (or whatever maps)

### Security

**No LAN authentication.** Both protocols are trusted-LAN by design. Do NOT expose printer ports to the internet. Do NOT run lootgoblin on a network shared with untrusted devices.

The 'sdcp_passcode' credential kind exists for future firmware that may add auth — currently stores empty payload. Encrypted at rest via LOOTGOBLIN_SECRET regardless.

### Real-printer smoke tests

`forge-sdcp-real.test.ts` skips unless these env vars are set:
```
LG_TEST_SDCP_IP=192.168.1.42
LG_TEST_SDCP_MAINBOARD_ID=<from printer info screen>
LG_TEST_SDCP_KIND=sdcp_elegoo_saturn_4_ultra   # optional
LG_TEST_SDCP_PORT=3030                          # optional
```

`forge-chitu-real.test.ts` skips unless:
```
LG_TEST_CHITU_IP=192.168.1.43
LG_TEST_CHITU_KIND=chitu_network_phrozen_sonic_mighty_8k   # optional
LG_TEST_CHITU_PORT=3000                                     # optional
```

Both tests use startPrint=false — file uploads to /local/ but no actual print starts. Skipped in CI.

## V2-005f Status Feeds + Consumption

V2-005f wires a per-printer status subscriber subsystem on top of the V2-005d dispatcher pillars. After a dispatch transitions to `dispatched`, the status worker spins up a protocol-specific subscriber for that printer; events flow through the worker to `dispatch_status_events` (audit log) and the V2-007a Ledger (consumption events).

### Lifecycle

1. **Lazy-start**: when a `dispatch_jobs.status` transitions to `'dispatched'`, the status worker creates a subscriber (Moonraker WS, OctoPrint SockJS, Bambu MQTT, SDCP WS, or ChituNetwork TCP) for that printer if one isn't already running.
2. **Auto-stop**: when the last `dispatched` job for a printer reaches a terminal state (`completed` / `failed`), the worker schedules a 30-second teardown grace timer. New dispatches arriving during the grace cancel the teardown.
3. **Reconnect**: subscribers handle disconnects via exponential backoff: 5s → 10s → 30s → 60s → 5min cap. Reconnect continues forever until the printer comes back or the last dispatch terminates.
4. **Boot resilience**: on lootgoblin restart, the worker re-attaches subscribers for all in-flight `dispatched` jobs.

### Adaptive polling — ChituNetwork

ChituNetwork (legacy ChituBox firmware on Phrozen / Uniformation / older Elegoo) has no push protocol. The subscriber uses an adaptive M27 polling cadence:

| State | Poll interval | Trigger |
|---|---|---|
| IDLE | 60s | default at connect |
| PRINTING | 10s | dispatch sent M6030 (worker signal) OR M27 reports active print |
| NEAR_COMPLETION | 2s | M27 reports ≥90% bytes-printed |
| JUST_FINISHED | 30s | transition from PRINTING/NEAR back to idle (5 min then back to IDLE) |

For 100 printers running idle: ~5 req/s aggregate. For 100 printers actively printing: ~10 req/s. The cadence is bounded.

### Multi-slot consumption (AMS et al.)

Bambu MQTT exposes per-slot tray remaining percentages (`ams.tray[i].remain`). The status subscriber emits `measuredConsumption` arrays on terminal events; the V2-005f consumption emitter back-calculates measured grams per slot:

```
measured_grams = slicer_estimated_grams × (1 - remain_percent_at_completion / 100)
```

This is a **simplification** — full per-spool tracking requires V2-005f-CF-1 (material loadout tracking), where operators tag which `materials` row is loaded in which printer slot at print time. Until CF-1 ships, consumption events emit only when `dispatch_jobs.materials_used[].material_id` is manually populated.

OctoPrint, Moonraker, SDCP, and ChituNetwork do not surface per-slot consumption. For those protocols, only the slicer-estimated phase A consumption is recorded (as `provenance='estimated'` in the ledger).

### Idempotency

Reconnect storms can cause duplicate status events for the same dispatch. The consumption emitter dedupes against the ledger via `(dispatch_job_id, slot_index, provenanceClass)` triple — implemented as a `note='slot:N'` field on the `material.consumed` ledger payload, queried via `json_extract` before each emission. Duplicate consumption is a silent no-op.

`dispatch_status_events` rows are NOT deduped — each event gets its own UUID. The audit log preserves all signal including reconnect storms.

### HTTP API

- `GET /api/v1/forge/dispatch/:id/status` — owner-or-admin. Returns `{ dispatch_job_id, status, progress_pct, last_status_at, events: [...latest 50 ordered DESC] }`.
- `GET /api/v1/forge/dispatch/:id/status/stream` — owner-or-admin Server-Sent Events. Streams `event: status\ndata: <json>\n\n` per printer event. Auto-disconnects on terminal state. Already-terminal dispatches return one terminal frame and close. Heartbeat every 30s.

UI clients should prefer SSE for live progress and fall back to polling `/status` for historical state.

### Real-printer smoke tests

Five env-gated tests at `apps/server/tests/integration/status-{moonraker,octoprint,bambu,sdcp,chitu}-real.test.ts` connect to real printers when local env vars are set:

- `LG_TEST_MOONRAKER_HOST` + `LG_TEST_MOONRAKER_API_KEY`
- `LG_TEST_OCTOPRINT_HOST` + `LG_TEST_OCTOPRINT_API_KEY`
- `LG_TEST_BAMBU_IP` + `LG_TEST_BAMBU_ACCESS_CODE` + `LG_TEST_BAMBU_SERIAL`
- `LG_TEST_SDCP_IP` + `LG_TEST_SDCP_MAINBOARD_ID`
- `LG_TEST_CHITU_IP`

Each test connects with the real subscriber (no mocked transport), waits for at least one `StatusEvent`, then `stop()`s cleanly and verifies the `isConnected()` lifecycle (true before stop, false after). Run individually:

```bash
LG_TEST_MOONRAKER_HOST=voron.lan LG_TEST_MOONRAKER_API_KEY=$KEY \
  npx vitest run tests/integration/status-moonraker-real.test.ts
```

CI never sets these → tests are no-ops. Used by ops/dev to validate against actual hardware.

### Carry-forwards

- **V2-005f-CF-1**: Material loadout tracking — auto-populate `dispatch_jobs.materials_used[].material_id` from the printer's currently-loaded spool inventory (today operators set this manually). **Shipped — see V2-005f-CF-1 section below.**
- **V2-005f-CF-2**: SSE retention policy + dispatch_status_events archival.
- **V2-005f-CF-3**: Smart polling backoff for ChituNetwork printers that go offline.
- **V2-005f-CF-4**: Multi-printer concurrent reconnect storm hardening.
- **V2-005f-CF-5**: Print-failure detection from slicer-estimate divergence.
- **V2-005f-CF-6**: Playwright UI tests for status SSE streams (blocked on V2-009 UI scope).
- **V2-005f-CF-7**: Encrypted CTB binary header parsing (today encrypted variants return null estimates).

## V2-005f-CF-1 Material Loadout Tracking

V2-005f shipped the consumption-emission plumbing, but `dispatch_jobs.materials_used[].material_id` was always empty because no source-of-truth for "what spool is loaded in printer P slot N right now?" existed. Operators had to manually pre-populate the column for any consumption ledger event to fire. CF-1 closes that gap: a first-class `printer_loadouts` table records every load/unload, and the claim worker auto-fills `material_id` from the current loadout when a dispatch is claimed.

### Data model

A new `printer_loadouts` table (migration 0030) records every load/unload as a row. Current state is `WHERE unloaded_at IS NULL`; history is older rows with `unloaded_at` populated. A partial unique index (`idx_printer_loadouts_current` on `(printer_id, slot_index)` where `unloaded_at IS NULL`) guarantees at-most-one open row per (printer, slot).

Atomic swap on slot conflict: when an operator says "load this spool here" while a different spool is already in that slot, the incumbent row is stamped with `unloaded_at` and a new row is inserted in ONE transaction, with TWO ledger events emitted — `material.unloaded` (reason='swap') for the outgoing spool + `material.loaded` for the incoming spool (payload includes `swappedOutMaterialId`). Either both happen or neither.

Migration 0030 also dropped the V2-007a-T4 free-text `materials.loaded_in_printer_ref` column — the `printer_loadouts` table is the single source of truth.

### HTTP API

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/api/v1/materials/:id/load` | `{ printerId, slotIndex, notes? }` | 200 `{ loadoutId, swappedOutMaterialId? }` |
| POST | `/api/v1/materials/:id/unload` | `{ notes? }` | 200 `{ loadoutId, previousPrinterId, previousSlotIndex }` |
| GET | `/api/v1/forge/printers/:id/loadout` | — | 200 `{ slots: [{ slotIndex, materialId, loadoutId, loadedAt, ... }] }` |
| GET | `/api/v1/materials/:id/loadout-history` | — | 200 `{ history: [{ loadoutId, printerId, slotIndex, loadedAt, unloadedAt, ... }] }` |

### Error codes

- `404` — `material-not-found` / `printer-not-found`
- `409` — `material-already-loaded-elsewhere` / `material-retired` / `material-not-loaded`
- `400` — `invalid-slot` (slotIndex must be a non-negative integer)

### Ledger events

Every load/unload is durably recorded via the V2-007a-T3 ledger inside the same transaction as the table write — the audit trail rolls back together with the row.

| Kind | Subject | Payload |
|---|---|---|
| `material.loaded` | `materialId` | `{ printerId, slotIndex, loadoutId, swappedOutMaterialId? }` |
| `material.unloaded` | `materialId` | `{ printerId, slotIndex, loadoutId, reason: 'swap' \| 'manual' }` |

Both rows carry `provenance_class='entered'` (operator-asserted truth, distinct from the `'measured'` and `'estimated'` rows that consumption emission writes).

### Slot indexing

`slot_index` is a flat global integer. For multi-AMS Bambu printers the V2-005f Bambu subscriber convention is preserved:

```
slot_index = unit * 4 + tray.id
```

So AMS unit 0 / tray 0 → slot 0, AMS unit 0 / tray 3 → slot 3, AMS unit 1 / tray 0 → slot 4, AMS unit 1 / tray 1 → slot 5, etc.

Non-AMS printers (single-extruder Klipper / OctoPrint / SDCP / ChituNetwork) always use `slot_index=0`.

The UI translates display strings (e.g. "AMS 2 / Slot 1" → 5) at render time; the API and DB columns always use the flat integer.

### Claim worker integration

When a printer-target dispatch is claimed (`runOneClaimTick`):

1. The claim worker resolves the dispatch's machine-facing artifact and runs `extractSlicerEstimate` against it.
2. It calls `getCurrentLoadout(printerId)` to map `slot_index → material_id` for every currently-loaded slot.
3. It UPDATEs `dispatch_jobs.materials_used` with one entry per slicer-estimate slot, filling `material_id` from the loadout map.
4. Slots that the slicer estimate references but the printer has nothing loaded into log a `forge-claim: slicer-estimate references slot with no loaded material` warning and ship `material_id: ''`. The Phase A and Phase B consumption emitters skip empty-`material_id` slots silently — the print proceeds unimpeded.

The end-to-end consequence: with the loadout populated before claim, both Phase A (`provenance='estimated'`) and Phase B (`provenance='measured'`) consumption events land in the ledger automatically. V2-007a-T13 reports query by provenance — both decrements are intentional and surface separately.

### Operator workflow

1. **Load a fresh spool**: `POST /api/v1/materials/:id/load { printerId, slotIndex }`. Returns `{ loadoutId }` and emits a `material.loaded` ledger row.
2. **Dispatch normally**. The claim worker auto-fills `materials_used[].material_id` from the current loadout — no manual `materials_used` setup required.
3. **Unload or swap**:
   - Manual unload: `POST /api/v1/materials/:id/unload`. Stamps `unloaded_at`, emits `material.unloaded` (reason='manual').
   - Swap: just `POST /api/v1/materials/:other-id/load { printerId, slotIndex: <same> }`. Atomic swap fires automatically — the incumbent's row is closed and a new row opened in ONE transaction with two ledger events.
4. **Inspect current loadout**: `GET /api/v1/forge/printers/:id/loadout` returns the slot list.
5. **Audit history**: `GET /api/v1/materials/:id/loadout-history` returns every (printer, slot, load, unload) tuple this material has lived in.

### Carry-forwards

- **V2-005f-CF-1-CF-A**: Rename the `loadedInPrinterRef` field on the Material DTO to `loadedInPrinterId` for clarity. The string still reflects the new schema's first-class FK; only the field name needs the lift.
- **V2-005f-CF-2** (existing, unrelated): SSE retention policy + dispatch_status_events archival.

## V2-005e Slicer Dispatchers + Watched Inbox

V2-005e closes the gap between "operator slices in their preferred GUI" and "lootgoblin dispatches the result to a printer." The operator slices in Bambu Studio / OrcaSlicer / Lychee / Chitubox / etc., exports the sliced file to a watched directory on the lootgoblin host, and lootgoblin auto-ingests the slice + auto-links it to its source STL/3MF Loot. The operator then dispatches via the existing V2-005d `POST /api/v1/forge/dispatch` flow. Status feeds + consumption emission take over via V2-005f (see V2-005f section above).

This shipped server-side only. UI buttons (Loot detail "Send to Slicer", Inboxes config page, Pending pairings queue browse) and browser-extension augmentation are deferred to V2-005e-CF-1 / CF-2 / CF-3.

### Watched inbox configuration

A `forge_inboxes` table holds operator-configured directories. Each inbox has:

- `name` — human label
- `path` — absolute filesystem path on the lootgoblin host
- `defaultPrinterId` — optional default dispatch target
- `active` — toggle for pause/resume without deletion
- `notes` — free-text

A chokidar watcher tails each active inbox; new file events trigger the matcher. On lootgoblin startup, instrumentation re-attaches watchers for every active inbox (boot resilience — same shape as the V2-005f status worker reconnect).

HTTP API (owner-or-admin):

```
POST   /api/v1/forge/inboxes      { name, path, defaultPrinterId?, notes? }
GET    /api/v1/forge/inboxes
GET    /api/v1/forge/inboxes/:id
PATCH  /api/v1/forge/inboxes/:id  { name?, path?, defaultPrinterId?, active?, notes? }
DELETE /api/v1/forge/inboxes/:id
```

### Three-tier source-Loot association

When a slice file lands in a watched inbox, the matcher attempts three strategies in order — first hit wins:

1. **Sidecar metadata** (highest confidence)
   - `.gcode.3mf` / `.3mf`: opened with JSZip; `Metadata/model_settings.config` is parsed for source filename and 3MF UUID
   - Plain `.gcode`: header is regex-scraped for `; thumbnail_source = ...`, `; source = ...`, `; original_filename = ...`
   - Match runs against existing Loot rows by basename + UUID when present
2. **Filename heuristic** (medium confidence)
   - Slicer-suffix patterns are stripped (`_PLA_0.2mm`, `_2color`, `_4h32m`, `_(plate1)`, etc.)
   - Fuzzy match against owner's source Loot basenames using Dice's coefficient
   - Threshold: ≥ 0.7 similarity ratio
3. **Pending pairings queue** (no match)
   - A `forge_pending_pairings` row is inserted with `resolved_at=NULL`
   - The slice still ingests + dispatches normally — it just lands unattributed (`loot.parent_loot_id = NULL`)
   - Operator resolves manually:
     ```
     GET  /api/v1/forge/pending-pairings
     POST /api/v1/forge/pending-pairings/:id/resolve  { sourceLootId }
     ```

The `slicer-output` classifier rule tags arriving files based on extension (`.gcode`, `.gcode.3mf`, `.bgcode`, `.ctb`, `.cbddlp`, `.jxs`, `.sl1`, `.sl1s`). The 3MF classifier provider was narrowed to skip `.gcode.3mf` so plain Bambu Studio source `.3mf` files don't get mis-tagged as slices.

### Slicer launch URI registry

A TS-side constant `SLICER_LAUNCH_REGISTRY` maps 11 slicer kinds to URI deep-link templates:

| Slicer | URI scheme | Notes |
|---|---|---|
| Bambu Studio | `bambu-connect://import-file?url=...` | direct deep link |
| OrcaSlicer | `orcaslicer://open?url=...` | direct deep link |
| ChiTuBox | `chitubox://open?file=...` | direct deep link |
| Lychee Slicer | `lychee://open?file=...` | direct deep link |
| PrusaSlicer | none | download fallback |
| SuperSlicer | none | download fallback |
| Cura | none | download fallback |
| Photon Workshop | none | download fallback |
| Halot Box | none | download fallback |
| PreForm | none | download fallback |
| Asiga Composer | none | download fallback |

Operators (and a future UI) query:

```
GET /api/v1/forge/slicers/launch-uri?slicerKind=bambu_studio&lootFileId=<id>
```

Response for a slicer with a registered scheme:

```json
{ "uri": "bambu-connect://import-file?url=https://lootgoblin.local/api/v1/loot/files/<id>", "fallback": null }
```

Response for a slicer with no scheme:

```json
{ "uri": "", "fallback": "download" }
```

Front-end calling this endpoint should branch: when `uri` is non-empty, navigate the user-agent to it (the OS hands off to the slicer); when `fallback === "download"`, trigger a `Content-Disposition: attachment` download from the same Loot file URL instead.

### Browser limitation: URLs work, local FS paths don't

**Most browsers refuse to pass local filesystem paths to URI handlers from remote-origin pages.** The launch URI deliberately uses lootgoblin's HTTP file-serving URL (the `{url}` placeholder) — browsers WILL pass remote URLs to registered URI handlers, so the slicer opens with the file fetched from lootgoblin's URL.

This sidesteps the UX gap the original V2-005e plan stub flagged. True one-click open-in-slicer with a local FS path requires a browser extension that can bypass remote-origin restrictions — that's the V2-005e-CF-2 carry-forward.

### Operator workflow

1. Configure an inbox once: `POST /api/v1/forge/inboxes { name, path }`
2. Slice in your preferred GUI; export to the watched directory
3. Lootgoblin auto-ingests + auto-links to source Loot (or queues for manual resolve via the pending-pairings endpoint)
4. Dispatch via the existing V2-005d `POST /api/v1/forge/dispatch` flow
5. Status feeds + consumption emission take over (see V2-005f section above)

### Carry-forwards

- **V2-005e-CF-1**: Loot detail UI — "Send to Slicer" buttons + Inboxes config UI.
- **V2-005e-CF-2**: Browser extension augmentation — true one-click open-in-slicer with a local FS path (bypasses the remote-origin browser limitation above).
- **V2-005e-CF-3**: Pending-pairings queue browse UI.
- **V2-005e-CF-4**: Sidecar metadata extraction for additional formats — `.ctb` header source-file reference, NanoDLP zip metadata, `.sl1` sidecar.
- **V2-005e-CF-Z**: Proper FS adapter handoff for slice files (today they're stored AS-IS at the inbox-arrived path; should move to per-inbox stash root with path-template-driven placement, matching the rest of V2-002's portable-paths convention).

