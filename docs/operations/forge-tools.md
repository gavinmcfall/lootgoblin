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
