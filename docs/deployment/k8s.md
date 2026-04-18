# Kubernetes deployment (bjw-s app-template)

LootGoblin ships with a reference [bjw-s/helm-charts app-template](https://bjw-s.github.io/helm-charts/docs/app-template/) `values.yaml` at [`docs/deployment/k8s/values.example.yaml`](k8s/values.example.yaml). This is the default homelab pattern — if you run your stack differently (raw manifests, Kustomize, Flux, etc.), adapt as needed.

## Quickstart

```bash
# 1. Add the bjw-s helm repo
helm repo add bjw-s https://bjw-s.github.io/helm-charts
helm repo update

# 2. Create the namespace
kubectl create ns lootgoblin

# 3. Create a PVC for /config
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: lootgoblin-config
  namespace: lootgoblin
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
EOF

# 4. Create the secret — use sealed-secrets / external-secrets / SOPS in production.
#    Template at docs/deployment/k8s/lootgoblin-secret.example.yaml.
openssl rand -hex 32 | xargs -I{} \
  kubectl create secret generic lootgoblin-secret \
    --namespace lootgoblin \
    --from-literal=LOOTGOBLIN_SECRET={}

# 5. Copy values.example.yaml, edit for your cluster (ingress host, library NFS, OIDC)
curl -O https://raw.githubusercontent.com/gavinmcfall/lootgoblin/main/docs/deployment/k8s/values.example.yaml
cp values.example.yaml values.yaml
$EDITOR values.yaml  # replace image tag digest, ingress host, library path

# 6. Install
helm upgrade --install lootgoblin bjw-s/app-template \
  --namespace lootgoblin \
  --values values.yaml

# 7. Open your ingress host, run the first-run wizard
```

## Getting the image digest

Every release publishes a manifest-list digest. Find it on the [GitHub Release page](https://github.com/gavinmcfall/lootgoblin/releases) under "Pin by digest":

```
ghcr.io/gavinmcfall/lootgoblin@sha256:abc123...
```

Paste that digest into `values.yaml`'s `controllers.lootgoblin.containers.app.image.tag`. Renovate (with [`renovate.json`](../../renovate.json)) keeps it current automatically.

## Verifying build provenance

Images are signed with GitHub OIDC via [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance). Verify before deploying:

```bash
gh attestation verify oci://ghcr.io/gavinmcfall/lootgoblin@sha256:<digest> \
  --owner gavinmcfall
```

## Library volumes

LootGoblin writes scraped packages into per-destination filesystem paths. The example `values.yaml` mounts your NAS via NFS at `/library/3DModels`. When creating a destination in the LootGoblin UI, the `path` field should match a mounted path inside the container (e.g. `/library/3DModels/Miniatures`).

Swap NFS for whatever fits your cluster — hostPath, CSI-backed PVCs, Longhorn volumes, etc. The container runs as `65534:65534` so make sure the volume's access mode allows writes for that user.

## Integration with Manyfold

If you already run [Manyfold](https://manyfold.app/), point LootGoblin's destination path at the same directory your Manyfold instance indexes. LootGoblin writes Manyfold-compatible `datapackage.json` sidecars + files; Manyfold picks them up on its next library scan.

## Troubleshooting

- **Pod CrashLoopBackOff with "Invalid environment: LOOTGOBLIN_SECRET":** the secret isn't mounted. Check `kubectl get secret lootgoblin-secret -n lootgoblin -o yaml` and confirm `envFrom.secretRef.name` in `values.yaml` matches.
- **Library writes fail with EACCES:** the PVC / NFS mount doesn't grant write permission to UID 65534. Fix permissions on the host OR set `containers.app.securityContext.fsGroup` to a GID that has write access.
- **OIDC sign-in 500s:** check `OIDC_REDIRECT_URI` matches exactly what's registered with your IdP (trailing slash sensitive).
