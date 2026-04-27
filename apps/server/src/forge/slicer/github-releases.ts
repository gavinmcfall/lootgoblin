/**
 * GitHub Releases probe for slicer assets.
 *
 * Pure module: no DB or filesystem dependencies. HTTP is injected via
 * {@link HttpClient} so unit tests can supply mocks. Production callers
 * use {@link makeFetchHttpClient} for native `fetch`-backed I/O.
 *
 * V2-005c-T_c2.
 */

export interface HttpClient {
  fetchJson: (url: string) => Promise<any>;
  fetchText: (url: string) => Promise<string>;
  /**
   * Fetch a binary asset. Used by the installer (T_c3) to download AppImages.
   * Added preemptively here to avoid a breaking interface change later.
   */
  fetchBytes: (url: string) => Promise<Uint8Array>;
}

export interface ReleaseInfo {
  version: string;
  assetUrl: string;
  assetName: string;
  /** Empty string if no SHA256SUMS-style file is published in the release. */
  sha256: string;
  sizeBytes: number;
}

const REPOS = {
  prusaslicer: 'prusa3d/PrusaSlicer',
  orcaslicer: 'SoftFever/OrcaSlicer',
  bambustudio: 'bambulab/BambuStudio',
} as const;

export type SlicerKind = keyof typeof REPOS;

const LINUX_PATTERNS: RegExp[] = [
  /linux.*x64.*\.AppImage$/i,
  /linux.*x86_64.*\.AppImage$/i,
  /linux.*x64.*\.tar\.(gz|xz)$/i,
  /linux.*x86_64.*\.tar\.(gz|xz)$/i,
];

const SUMS_PATTERN = /SHA256SUMS|checksums?\.txt/i;
const TAG_PREFIX_PATTERN = /^(version_|v)/;

export async function probeLatestRelease(opts: {
  slicerKind: SlicerKind;
  http: HttpClient;
}): Promise<ReleaseInfo> {
  const repo = REPOS[opts.slicerKind];
  const release = await opts.http.fetchJson(
    `https://api.github.com/repos/${repo}/releases/latest`,
  );

  const version = String(release.tag_name).replace(TAG_PREFIX_PATTERN, '');

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const linuxAsset = assets.find((a: any) =>
    LINUX_PATTERNS.some((p) => p.test(String(a?.name ?? ''))),
  );
  if (!linuxAsset) {
    throw new Error(`no linux x64 asset found in ${repo} ${release.tag_name}`);
  }

  const sumsAsset = assets.find((a: any) => SUMS_PATTERN.test(String(a?.name ?? '')));
  let sha256 = '';
  if (sumsAsset?.browser_download_url) {
    const sums = await opts.http.fetchText(sumsAsset.browser_download_url);
    const match = sums.split('\n').find((l) => l.includes(linuxAsset.name));
    if (match) {
      const first = match.trim().split(/\s+/)[0];
      if (first) sha256 = first;
    }
  }

  return {
    version,
    assetUrl: linuxAsset.browser_download_url,
    assetName: linuxAsset.name,
    sha256,
    sizeBytes: Number(linuxAsset.size ?? 0),
  };
}

export function makeFetchHttpClient(): HttpClient {
  const headers = { 'User-Agent': 'lootgoblin-forge' } as const;
  return {
    fetchJson: async (url) => {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return r.json();
    },
    fetchText: async (url) => {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return r.text();
    },
    fetchBytes: async (url) => {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      const buf = await r.arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}
