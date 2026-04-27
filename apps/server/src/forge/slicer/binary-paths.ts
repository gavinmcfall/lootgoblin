/**
 * binary-paths.ts — V2-005c T_c3
 *
 * Filesystem-layout helpers for runtime-installed slicer binaries.
 *
 * Layout under FORGE_TOOLS_ROOT (default `/data/forge-tools`):
 *
 *   <root>/
 *     prusaslicer/<version>/bin/prusaslicer.AppImage   (AppImage release)
 *     orcaslicer/<version>/bin/orcaslicer              (tar.gz release, post-extract)
 *     bambustudio/<version>/bin/bambustudio.AppImage
 *     .tmp/<random>-<assetName>                        (download scratch space)
 *
 * Path discovery for tarball-based slicers is intentionally a stub here —
 * the installer (T_c3) sets `<installRoot>/bin/<kind>` and T_c8
 * (Prusa-fork SlicerAdapter) refines once the on-disk shape per fork is
 * locked.
 */
import path from 'node:path';

import type { ForgeSlicerKindInstallable } from '@/db/schema.forge';

const DEFAULT_FORGE_TOOLS_ROOT = '/data/forge-tools';

/** Reads FORGE_TOOLS_ROOT env var; defaults to '/data/forge-tools'. */
export function getForgeToolsRoot(): string {
  const v = process.env.FORGE_TOOLS_ROOT;
  return v && v.length > 0 ? v : DEFAULT_FORGE_TOOLS_ROOT;
}

/** Returns `${getForgeToolsRoot()}/${kind}/${version}`. */
export function getInstallRoot(
  kind: ForgeSlicerKindInstallable,
  version: string,
): string {
  return path.join(getForgeToolsRoot(), kind, version);
}

/**
 * Derive the final binary path for an installed asset.
 *   - AppImage assets → `<installRoot>/bin/<kind>.AppImage`
 *   - tar.gz/tar.xz   → `<installRoot>/bin/<kind>` (T_c8 will refine the
 *                       per-fork sub-path inside the tarball; for now this
 *                       is the placeholder the installer records)
 */
export function getBinaryPathForAsset(opts: {
  installRoot: string;
  kind: ForgeSlicerKindInstallable;
  assetName: string;
}): string {
  const lower = opts.assetName.toLowerCase();
  if (lower.endsWith('.appimage')) {
    return path.join(opts.installRoot, 'bin', `${opts.kind}.AppImage`);
  }
  // tar.gz / tar.xz / unknown — placeholder. T_c8 will refine.
  return path.join(opts.installRoot, 'bin', opts.kind);
}
