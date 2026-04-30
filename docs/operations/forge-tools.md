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
