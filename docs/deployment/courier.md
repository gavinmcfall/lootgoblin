# Courier deployment

The Courier is a lightweight Go agent you run on any always-on box that has local network access to your 3D printers. It connects **outbound** to your central LootGoblin instance, pairs once with a short-lived token, and then claims and dispatches print jobs to printers on that LAN (Moonraker / Klipper for this release). No inbound ports are required.

## When you need a Courier

**You need a Courier only when your printers are on a different LAN from your LootGoblin server** — e.g. a printer at a second house, behind NAT, or on a VLAN the server cannot reach directly.

If all your printers are on the same LAN as LootGoblin (a typical single-household setup), you do **not** need a Courier — LootGoblin dispatches to Moonraker directly.

## Install paths

### Docker (one-liner)

```bash
docker run -d \
  --name courier \
  --restart unless-stopped \
  --network host \
  -v /path/to/config:/config \
  -e COURIER_SERVER_URL=https://lootgoblin.example.com \
  -e COURIER_NAME=garage-courier \
  -e COURIER_PAIR_TOKEN=<paste-pair-token-here> \
  ghcr.io/gavinmcfall/lootgoblin-courier:latest
```

`--network host` gives the Courier direct access to your printer LAN. If you prefer a bridge network, omit it and ensure the printer subnet is routable from the bridge (static route or VLAN).

After the first run completes pairing, remove `-e COURIER_PAIR_TOKEN=...` — the negotiated API key is persisted automatically to `/config/courier-state.json`.

### Docker Compose

Use the reference compose file at [`docs/deployment/courier/docker-compose.yml`](courier/docker-compose.yml).

```bash
# 1. Copy and edit the config
mkdir -p ./config
curl -O https://raw.githubusercontent.com/gavinmcfall/lootgoblin/main/docs/deployment/courier/courier.example.yml
cp courier.example.yml ./config/courier.yml
$EDITOR ./config/courier.yml   # fill in server_url and name

# 2. Set the pair token for first run (remove from env after pairing)
export COURIER_SERVER_URL=https://lootgoblin.example.com
export COURIER_NAME=garage-courier
export COURIER_PAIR_TOKEN=<paste-pair-token-here>

# 3. Download the compose file and start
curl -O https://raw.githubusercontent.com/gavinmcfall/lootgoblin/main/docs/deployment/courier/docker-compose.yml
docker compose up -d
```

After pairing succeeds, unset `COURIER_PAIR_TOKEN` (or remove the variable from your `.env`) and restart the service.

### Standalone binary + systemd (Linux)

**1. Download and verify**

Download the binary for your architecture from the [GitHub Releases page](https://github.com/gavinmcfall/lootgoblin/releases) (look for a `courier-v*` release). Each release includes a `checksums.txt`:

```bash
# Example for linux/amd64
curl -Lo courier https://github.com/gavinmcfall/lootgoblin/releases/download/courier-v<VERSION>/courier-linux-amd64
curl -Lo checksums.txt https://github.com/gavinmcfall/lootgoblin/releases/download/courier-v<VERSION>/checksums.txt
sha256sum --check --ignore-missing checksums.txt
chmod +x courier
sudo mv courier /usr/local/bin/courier

# Confirm the build
courier version
```

Available targets: `linux-amd64`, `linux-arm64`, `linux-armv7`, `darwin-amd64`, `darwin-arm64`.

**2. Create the config**

```bash
sudo mkdir -p /etc/lootgoblin
sudo curl -o /etc/lootgoblin/courier.yml \
  https://raw.githubusercontent.com/gavinmcfall/lootgoblin/main/docs/deployment/courier/courier.example.yml
sudo $EDITOR /etc/lootgoblin/courier.yml   # fill in server_url, name, pair_token
```

Alternatively place the config at `/config/courier.yml` (the default path) or point to it via `COURIER_CONFIG_PATH`.

**3. Create a systemd unit**

```ini
# /etc/systemd/system/courier.service
[Unit]
Description=LootGoblin Courier
After=network.target

[Service]
ExecStart=/usr/local/bin/courier
Restart=on-failure
RestartSec=5
# Optional — override the config path:
# Environment=COURIER_CONFIG_PATH=/etc/lootgoblin/courier.yml

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now courier
sudo journalctl -u courier -f
```

After the first run pairs successfully, remove `pair_token` from `courier.yml` (or unset `COURIER_PAIR_TOKEN`) and restart: `sudo systemctl restart courier`.

### Unraid

Use the Community Applications template at [`docs/deployment/courier/unraid-template.xml`](courier/unraid-template.xml).

**Steps:**

1. In Community Applications, click **Add Container**.
2. Click the template URL icon and paste:
   ```
   https://github.com/gavinmcfall/lootgoblin/blob/main/docs/deployment/courier/unraid-template.xml
   ```
3. Set **Config directory** to `/mnt/user/appdata/lootgoblin-courier`.
4. Set **Server URL**, **Courier name**, and (for first run) **Pair token**.
5. Click **Apply** and start the container.
6. Once pairing completes, clear the **Pair token** field and restart the container.

### TrueNAS SCALE

A dedicated catalog app is planned for a future release. For now, deploy via the docker-compose template:

1. In TrueNAS SCALE, go to **Apps → Manage Apps → Launch Docker Image** (or **Custom App** depending on your version).
2. Use the compose file at [`docs/deployment/courier/docker-compose.yml`](courier/docker-compose.yml) as reference for image, environment variables, and the `/config` volume mount.
3. Set `Network Type` to **Host** so the Courier can reach printers on the LAN.

### Windows (manual)

**1. Download**

Download `courier-windows-amd64.exe` from the [GitHub Releases page](https://github.com/gavinmcfall/lootgoblin/releases) and rename it to `courier.exe`. Place it somewhere on your PATH, e.g. `C:\tools\`.

**2. Create the config**

Save a copy of [`courier.example.yml`](courier/courier.example.yml) as `C:\tools\courier.yml` and fill in `server_url`, `name`, and (first run) `pair_token`.

**3. Run from a terminal**

```powershell
$env:COURIER_CONFIG_PATH = "C:\tools\courier.yml"
C:\tools\courier.exe
```

**4. Optional — run at startup via Task Scheduler**

1. Open **Task Scheduler → Create Basic Task**.
2. Set trigger: **When the computer starts**.
3. Action: **Start a program** → `C:\tools\courier.exe`.
4. Add `COURIER_CONFIG_PATH=C:\tools\courier.yml` as an environment variable via **Properties → Environment Variables** (or set it system-wide in Control Panel → System → Advanced → Environment Variables).

After pairing, remove `pair_token` from `courier.yml` and restart the task.

### Kubernetes (bjw-s app-template)

Use the reference values file at [`docs/deployment/courier/k8s-values.example.yaml`](courier/k8s-values.example.yaml).

**Key caveat — host network:** the Courier pod needs L2/L3 access to your printer LAN. The example values set `hostNetwork: true` on the pod. Run this pod on a node physically connected (or VLAN'd) to the printer subnet. If your CNI supports routable pod IPs (e.g. Cilium native routing with a static route to the printer VLAN), you can drop `hostNetwork`.

```bash
# 1. Create the namespace (skip if it exists)
kubectl create ns lootgoblin

# 2. Create the secret with required values
kubectl create secret generic courier-secret \
  --namespace lootgoblin \
  --from-literal=COURIER_SERVER_URL=https://lootgoblin.example.com \
  --from-literal=COURIER_NAME=garage-courier \
  --from-literal=COURIER_PAIR_TOKEN=<paste-pair-token-here>

# 3. Copy and edit the values file
curl -O https://raw.githubusercontent.com/gavinmcfall/lootgoblin/main/docs/deployment/courier/k8s-values.example.yaml
cp k8s-values.example.yaml values.yaml
$EDITOR values.yaml   # replace image digest, adjust resources if needed

# 4. Install
helm repo add bjw-s https://bjw-s.github.io/helm-charts
helm repo update
helm upgrade --install lootgoblin-courier bjw-s/app-template \
  --namespace lootgoblin \
  --values values.yaml
```

After pairing, update the secret to remove (or blank) `COURIER_PAIR_TOKEN` and rollout-restart the deployment.

## Pairing walkthrough

There is **no UI** for Courier pairing yet — the admin pairing page is a planned future slice. For now, mint a pair token via the admin API.

**Step 1 — Generate a pair token (30-minute TTL)**

Using an admin session cookie:

```bash
curl -s -X POST https://lootgoblin.example.com/api/v1/couriers/pair-tokens \
  -H "Cookie: <your-admin-session-cookie>"
```

Or using an admin API key:

```bash
curl -s -X POST https://lootgoblin.example.com/api/v1/couriers/pair-tokens \
  -H "X-API-Key: <your-admin-api-key>"
```

Response:

```json
{
  "token": "pt_abc123...",
  "expires_at": "2026-06-07T14:30:00Z"
}
```

The token expires in **30 minutes**. Use it promptly.

**Step 2 — Put the token in the Courier config**

In `courier.yml`:

```yaml
pair_token: "pt_abc123..."
```

Or as an environment variable:

```bash
COURIER_PAIR_TOKEN=pt_abc123...
```

**Step 3 — Start the Courier**

On first run, the Courier exchanges the pair token for a long-lived API key. That key is written to `/config/courier-state.json` (mode `0600`). You will see a log line like:

```
level=info msg="pairing complete" courier_id=<uuid>
```

**Step 4 — Remove the pair token**

Once pairing completes, remove `pair_token` from `courier.yml` (or unset `COURIER_PAIR_TOKEN`) and restart. The Courier will authenticate using the persisted key on all future starts.

> **Note:** A pair token is single-use and expires after 30 minutes. If the Courier fails to start within that window, generate a new token and try again.

> **UI forthcoming:** A Courier management page in the admin panel (list Couriers, revoke, re-pair) is planned for a future release.

## Configuration reference

All keys can be set in `courier.yml` **or** as environment variables. Environment variables take precedence.

| YAML key | Env var | Default | Meaning |
|---|---|---|---|
| `server_url` | `COURIER_SERVER_URL` | **required** | URL of the central LootGoblin instance |
| `name` | `COURIER_NAME` | **required** | Display name shown in the LootGoblin UI |
| `pair_token` | `COURIER_PAIR_TOKEN` | — | One-time token for initial pairing. Remove after first successful run. |
| `api_key` | `COURIER_API_KEY` | auto | Long-lived key. Normally set automatically and persisted to `courier-state.json`. Override only when migrating a Courier. |
| `heartbeat_interval_seconds` | `COURIER_HEARTBEAT_INTERVAL_SECONDS` | `30` | How often the Courier sends a heartbeat to the server (seconds) |
| `claim_poll_interval_seconds` | `COURIER_CLAIM_POLL_INTERVAL_SECONDS` | `5` | How often the Courier polls for new print jobs (seconds) |
| `default_filament_density_g_cm3` | `COURIER_DEFAULT_FILAMENT_DENSITY_G_CM3` | `1.24` | Fallback filament density when a job does not specify one (g/cm³) |
| `default_filament_diameter_mm` | `COURIER_DEFAULT_FILAMENT_DIAMETER_MM` | `1.75` | Fallback filament diameter when a job does not specify one (mm) |

Config file default path: `/config/courier.yml`. State (API key) is stored at `/config/courier-state.json` (mode `0600`).

## Verifying the image

Images are signed with GitHub OIDC via [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance). Verify before deploying:

```bash
gh attestation verify oci://ghcr.io/gavinmcfall/lootgoblin-courier:<tag> \
  --owner gavinmcfall
```

Digests are listed in each [GitHub Release](https://github.com/gavinmcfall/lootgoblin/releases). [Renovate](https://github.com/renovatebot/renovate) with `pinDigests` can track updates automatically (see the note in [`docs/deployment/courier/k8s-values.example.yaml`](courier/k8s-values.example.yaml)).

## Version compatibility

The Courier's **major version** must match the central LootGoblin instance's major version. The heartbeat handshake enforces this — a major mismatch results in a `version-incompatible` error and the Courier will not claim jobs.

Run `courier version` to check the installed build. Keep the Courier updated alongside the central instance when a major release is cut.

## Troubleshooting

- **Courier can't reach the printer (connection refused / timeout):** ensure the Courier host has network access to the printer's LAN. For Docker, use `--network host` or ensure the printer subnet is routable from the bridge network. For Kubernetes, confirm `hostNetwork: true` and that the pod is scheduled on a node connected to the printer VLAN.

- **Pairing error — "token not found" or "token expired":** the pair token has a 30-minute TTL and is single-use. Generate a new token via `POST /api/v1/couriers/pair-tokens` and try again.

- **Pairing error — "wrong token kind":** you have supplied an extension pair token instead of a Courier pair token (or vice versa). Regenerate from the correct endpoint.

- **`version-incompatible` on heartbeat:** the Courier major version does not match the server. Download the matching Courier binary or image from the [GitHub Releases page](https://github.com/gavinmcfall/lootgoblin/releases).

- **Where logs go:** the Courier writes structured JSON logs to **stderr**. For Docker: `docker logs courier`. For systemd: `journalctl -u courier -f`. For Kubernetes: `kubectl logs -n lootgoblin deployment/lootgoblin-courier`.
