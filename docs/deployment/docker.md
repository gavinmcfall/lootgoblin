# Docker deployment

LootGoblin ships as a single-container image on GHCR and Docker Hub, following the [home-operations container conventions](https://github.com/home-operations/containers): Alpine-based, non-root (`65534:65534` default), one process per container, stdout logs, `/config` volume.

## Quickstart

```bash
# 1. Grab the compose file
curl -O https://raw.githubusercontent.com/gavinmcfall/lootgoblin/main/docker-compose.yml

# 2. Generate a persistent secret (32 bytes hex)
echo "LOOTGOBLIN_SECRET=$(openssl rand -hex 32)" > .env

# 3. Optional: set PUID/PGID to your user so files land with correct ownership
echo "PUID=$(id -u)"  >> .env
echo "PGID=$(id -g)"  >> .env
echo "TZ=Pacific/Auckland"  >> .env

# 4. Optional: point at where your library lives on the host
echo "LIBRARY_HOST_PATH=/mnt/media/Library/3DModels"  >> .env

# 5. Start
docker compose up -d

# 6. Open http://localhost:7393 and run the first-run wizard
```

## `.env` reference

| Var | Required | Default | Purpose |
|---|---|---|---|
| `LOOTGOBLIN_SECRET` | **yes** | — | 32+ bytes hex. Encrypts source credentials. Server refuses to start without it. |
| `HOST_PORT` | no | `7393` | Port published on the host |
| `PUID` / `PGID` | no | `1000` / `1000` | User the container runs as (for volume write ownership) |
| `TZ` | no | `Pacific/Auckland` | Timezone |
| `LIBRARY_HOST_PATH` | no | `./library` | Host path mounted into `/library` |
| `DATABASE_URL` | no | `file:/config/lootgoblin.db` | SQLite path, or a `postgres://` URL |
| `AUTH_METHODS` | no | `forms` | csv of `forms,oidc` or exclusive `none` (reverse-proxy) |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` / `OIDC_ADMIN_GROUP` | no | — | Required when `AUTH_METHODS` includes `oidc` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | Set to enable OpenTelemetry export |
| `WORKER_CONCURRENCY` | no | `2` | Global worker pool size |
| `WORKER_PER_SOURCE_CONCURRENCY` | no | `1` | Per-source concurrency cap |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |

## Backing up

- `./data/lootgoblin.db` — SQLite database (queue, history, destinations, credentials)
- `./data/secret` — auto-generated if you didn't set `LOOTGOBLIN_SECRET`

**Warning:** if you lose `LOOTGOBLIN_SECRET`, all stored source credentials become unrecoverable. Back it up.

## Upgrading

Each release is published with an immutable `sha256` digest. Pin by digest for reproducible deploys:

```yaml
image: ghcr.io/gavinmcfall/lootgoblin@sha256:<digest>
```

Digests are listed in each [GitHub Release](https://github.com/gavinmcfall/lootgoblin/releases). [Renovate](https://github.com/renovatebot/renovate) with `pinDigests` can track updates for you (see [`renovate.json`](../../renovate.json)).

## Troubleshooting

- **Container exits immediately with "Invalid environment: LOOTGOBLIN_SECRET must be at least 32 bytes":** your `.env` secret is missing or too short. Regenerate with `openssl rand -hex 32` (produces 64 hex chars = 32 bytes).
- **`/api/health` returns 503 after first boot:** migrations run automatically on startup but credential-validity checks happen later. Safe to ignore for ~30s on first boot.
- **Files land with wrong ownership in `/library`:** set `PUID`/`PGID` to match the host user that owns the library directory.
