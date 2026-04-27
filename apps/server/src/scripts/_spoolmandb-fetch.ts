/**
 * SpoolmanDB fetcher — V2-007b T_B5a.
 *
 * Pulls the per-brand JSON files from the upstream Donkie/SpoolmanDB repo
 * pinned to a commit SHA (or `main` with a runtime warning). All fetches use
 * `globalThis.fetch` so tests can monkey-patch.
 *
 * Local on-disk cache: `.cache/spoolmandb/<commit-sha>/<brand-filename>` —
 * used so repeated runs (incl. `--dry-run`) don't hammer GitHub. Cache is
 * keyed by commit SHA, so a different `--ref` gets a fresh fetch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger';

const RAW_BASE = 'https://raw.githubusercontent.com/Donkie/SpoolmanDB';
const API_CONTENTS_BASE =
  'https://api.github.com/repos/Donkie/SpoolmanDB/contents/filaments';

const RATE_LIMIT_COOLDOWN_MS = 15_000;

/** Cache root (relative to process.cwd()). Override via env in tests. */
function cacheRoot(): string {
  const override = process.env.SPOOLMANDB_CACHE_DIR;
  if (override && override.length > 0) return override;
  return path.join(process.cwd(), '.cache', 'spoolmandb');
}

function cacheDirFor(commitSha: string): string {
  return path.join(cacheRoot(), commitSha);
}

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  // Single retry after a fixed cooldown if rate-limited (403/429).
  let attempt = 0;
  while (true) {
    const res = await globalThis.fetch(url, init);
    if (res.status !== 403 && res.status !== 429) return res;
    attempt++;
    if (attempt >= 2) return res; // give up; caller will throw
    logger.warn(
      { url, status: res.status, attempt },
      'spoolmandb-fetch: rate-limited, sleeping before retry',
    );
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_COOLDOWN_MS));
  }
}

interface GithubContentsEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  download_url?: string | null;
}

/**
 * List all brand JSON files in `filaments/` at the given commit SHA.
 * Returns the file *names* (e.g. `["Bambu.json", "Polymaker.json", ...]`).
 *
 * Cached at `<cacheDir>/_manifest.json`.
 */
export async function fetchSpoolmanDbBrandManifest(commitSha: string): Promise<string[]> {
  const dir = cacheDirFor(commitSha);
  const manifestPath = path.join(dir, '_manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
        return parsed;
      }
    } catch (err) {
      logger.warn({ err, manifestPath }, 'spoolmandb-fetch: cached manifest unreadable; refetching');
    }
  }

  const url = `${API_CONTENTS_BASE}?ref=${encodeURIComponent(commitSha)}`;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'lootgoblin-spoolmandb-importer',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) {
    throw new Error(
      `SpoolmanDB manifest fetch failed: ${res.status} ${res.statusText} for ${url}`,
    );
  }
  const body = (await res.json()) as GithubContentsEntry[];
  const filenames = body
    .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();

  // Persist cache.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(filenames, null, 2));
  return filenames;
}

/**
 * Fetch one brand JSON file at the pinned commit SHA. Returns the parsed
 * JSON object verbatim (caller validates shape).
 *
 * Cached on disk at `<cacheDir>/<brandFilename>`.
 */
export async function fetchSpoolmanDbBrandFile(
  commitSha: string,
  brandFilename: string,
): Promise<unknown> {
  if (!/^[A-Za-z0-9._-]+\.json$/.test(brandFilename)) {
    throw new Error(`SpoolmanDB invalid brand filename: ${brandFilename}`);
  }
  const dir = cacheDirFor(commitSha);
  const filePath = path.join(dir, brandFilename);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      logger.warn({ err, filePath }, 'spoolmandb-fetch: cached file unreadable; refetching');
    }
  }

  const url = `${RAW_BASE}/${encodeURIComponent(commitSha)}/filaments/${encodeURIComponent(brandFilename)}`;
  const headers: Record<string, string> = {
    'user-agent': 'lootgoblin-spoolmandb-importer',
  };
  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) {
    throw new Error(
      `SpoolmanDB brand fetch failed: ${res.status} ${res.statusText} for ${url}`,
    );
  }
  const text = await res.text();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, text);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `SpoolmanDB brand JSON parse failed for ${brandFilename}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
