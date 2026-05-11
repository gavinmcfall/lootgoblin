/**
 * Link Resolver — pure-function URL dispatcher for embedded links.
 *
 * Identifies known source-URL patterns in body text (e.g. Patreon post bodies,
 * item descriptions) and maps them to SourceId values. The resolver does NOT
 * fetch — it routes. Downstream code pairs resolver output with
 * `registry.getById(sourceId)` to obtain the actual adapter.
 *
 * No DB, HTTP, or filesystem imports. No pino logging — caller logs.
 */

import type { SourceId } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context extracted from a URL. Fields are source-specific; only the fields
 * relevant to the matched source will be populated.
 */
export type LinkContext = {
  /**
   * GDrive / MEGA / MMF / Cults3D / Thingiverse / Printables / MakerWorld /
   * Sketchfab / Patreon: the primary item id extracted from the URL path.
   */
  id?: string;
  /**
   * URL shape for GDrive ('file' | 'folder' | 'open') and MEGA ('file' | 'folder').
   */
  kind?: 'file' | 'folder' | 'open';
  /**
   * GDrive: resource key from shared-link query param `resourcekey=…`.
   * Required to access certain shared files without a Google account.
   */
  resourceKey?: string;
  /**
   * MEGA: the full fragment string (e.g. "#F!abc123!keypart" for legacy format,
   * or the fragment after the path for modern URLs). Contains decryption key.
   */
  fragment?: string;
};

/**
 * Discriminated union returned by `resolve()`.
 *
 * - `known`: URL matched a recognised source; `normalizedUrl` is canonical.
 * - `unknown`: URL was not recognised; `rawUrl` is returned as-is.
 */
export type LinkResolution =
  | { kind: 'known'; sourceId: SourceId; normalizedUrl: string; context?: LinkContext }
  | { kind: 'unknown'; rawUrl: string };

export interface LinkResolver {
  /**
   * Identify a single URL. Returns either a known source with optional context,
   * or unknown. Never throws — malformed URLs yield `unknown`.
   */
  resolve(url: string): LinkResolution;

  /**
   * Scan a blob of text (e.g. a Patreon post body) and return every resolvable
   * URL found, deduplicated by normalizedUrl (or rawUrl for unknowns).
   * Preserves first-appearance order. Unknown URLs are included — callers can
   * log them as future-adapter candidates.
   */
  scan(text: string): LinkResolution[];
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Tracking query-param keys that should be stripped during normalisation. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'msclkid',
  'ref',
  'usp', // Google Drive sharing hint — not resource-relevant
]);

/**
 * Normalise a URL string:
 * - Lowercase the hostname.
 * - Strip tracking query params.
 * - Strip trailing slashes from the pathname.
 * - Preserve the fragment (MEGA uses it for the decryption key).
 * - Preserve resource-relevant query params (e.g. `resourcekey` for GDrive).
 *
 * Returns null if the input cannot be parsed as a URL.
 */
function normalizeUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // Lowercase hostname.
  parsed.hostname = parsed.hostname.toLowerCase();

  // Strip embedded userinfo credentials — `new URL('https://user:pass@host').toString()`
  // preserves `user:pass@`, which would leak into logs, Set keys, and downstream storage.
  parsed.username = '';
  parsed.password = '';

  // Strip tracking params.
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) {
      parsed.searchParams.delete(key);
    }
  }

  // Strip trailing slash from pathname (but keep bare root '/').
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Per-source pattern matchers
// ---------------------------------------------------------------------------

type MatchResult = { sourceId: SourceId; context?: LinkContext } | null;

/** Extracts a numeric-or-alphanumeric segment from a path. */
function pathSegment(segments: string[], index: number): string | undefined {
  return segments[index] !== undefined && segments[index] !== '' ? segments[index] : undefined;
}

// ── Google Drive ────────────────────────────────────────────────────────────

/**
 * Explicit allowlist — only these hosts host GDrive-family resources with the
 * `/d/{id}` + `/folders/{id}` + `/open?id=` URL shapes. Using
 * `endsWith('.google.com')` would falsely claim `mail.google.com`,
 * `maps.google.com`, etc.
 */
const GDRIVE_HOSTS = new Set([
  'drive.google.com',
  'docs.google.com',
  'sheets.google.com',
  'slides.google.com',
]);

/**
 * Matches any drive.google.com or docs.google.com URL and extracts context.
 *
 * Shapes handled:
 *   /file/d/{id}/…
 *   /drive/folders/{id}
 *   /drive/u/N/folders/{id}
 *   /open?id={id}
 *   docs.google.com/document/d/{id}/…  (and sheets, slides, etc.)
 */
function matchGoogleDrive(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!GDRIVE_HOSTS.has(host)) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // /open?id=… (drive.google.com)
  if (host === 'drive.google.com' && parts[0] === 'open') {
    const id = parsed.searchParams.get('id') ?? undefined;
    if (!id) return null;
    return { sourceId: 'google-drive', context: { kind: 'open', id } };
  }

  // /file/d/{id}/…  (drive.google.com/file/d/{id}/view etc.)
  // Also catches docs.google.com/document/d/{id}/…
  {
    const dIdx = parts.indexOf('d');
    if (dIdx !== -1 && dIdx < parts.length - 1) {
      const id = pathSegment(parts, dIdx + 1);
      if (id) {
        const resourceKey = parsed.searchParams.get('resourcekey') ?? undefined;
        return { sourceId: 'google-drive', context: { kind: 'file', id, resourceKey } };
      }
    }
  }

  // /drive/folders/{id}  or  /drive/u/N/folders/{id}
  {
    const fIdx = parts.indexOf('folders');
    if (fIdx !== -1 && fIdx < parts.length - 1) {
      const id = pathSegment(parts, fIdx + 1);
      if (id) {
        return { sourceId: 'google-drive', context: { kind: 'folder', id } };
      }
    }
  }

  return null;
}

// ── MEGA ────────────────────────────────────────────────────────────────────

/**
 * Matches mega.nz URLs in three shapes:
 *   /folder/{id}#{key}
 *   /file/{id}#{key}
 *   /#F!{id}!{key}  (legacy)
 */
function matchMega(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (host !== 'mega.nz' && host !== 'mega.co.nz') return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // Legacy: /#F!id!key  (hash starts with "F!")
  if (parsed.hash.startsWith('#F!')) {
    return {
      sourceId: 'mega',
      context: { kind: 'folder', fragment: parsed.hash },
    };
  }

  // Modern /folder/{id} or /file/{id}
  if (parts.length >= 2) {
    const shape = parts[0]; // 'folder' or 'file'
    const id = parts[1];
    const fragment = parsed.hash || undefined;

    if (shape === 'folder') {
      return { sourceId: 'mega', context: { kind: 'folder', id, fragment } };
    }
    if (shape === 'file') {
      return { sourceId: 'mega', context: { kind: 'file', id, fragment } };
    }
  }

  return null;
}

// ── MyMiniFactory ───────────────────────────────────────────────────────────

/**
 * Matches myminifactory.com URLs:
 *   /object/…/{numericId}
 *   /users/{username}/collections/{slug}
 */
function matchMyMiniFactory(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('myminifactory.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // /object/{slug-numericId}  — real MMF URLs embed the numeric id as a trailing
  // suffix on the slug (e.g. /object/cool-castle-123456). Mirror the Printables
  // + MakerWorld pattern: extract the trailing numeric suffix when present.
  if (parts[0] === 'object') {
    const last = parts[parts.length - 1];
    if (last) {
      const idMatch = last.match(/-(\d+)$/);
      if (idMatch && idMatch[1]) {
        return { sourceId: 'mymini-factory', context: { kind: 'file', id: idMatch[1] } };
      }
      // Fallback: no trailing numeric suffix — use the whole segment as id.
      return { sourceId: 'mymini-factory', context: { kind: 'file', id: last } };
    }
  }

  // /users/{username}/collections/{slug}
  if (parts[0] === 'users' && parts[2] === 'collections') {
    const slug = parts[3];
    if (slug) {
      return { sourceId: 'mymini-factory', context: { kind: 'folder', id: slug } };
    }
  }

  return null;
}

// ── Cults3D ─────────────────────────────────────────────────────────────────

/**
 * Matches cults3d.com URLs with any locale prefix:
 *   /en/3d-model/{slug}
 *   /{locale}/3d-model/{slug}
 */
function matchCults3D(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('cults3d.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // Find the '3d-model' segment and take the next part as the slug.
  const modelIdx = parts.indexOf('3d-model');
  if (modelIdx !== -1) {
    const slug = pathSegment(parts, modelIdx + 1);
    if (slug) {
      return { sourceId: 'cults3d', context: { kind: 'file', id: slug } };
    }
  }

  return null;
}

// ── Thingiverse ──────────────────────────────────────────────────────────────

/**
 * Matches thingiverse.com thing URLs:
 *   /thing:{numericId}
 *   /thing:{numericId}/files
 */
function matchThingiverse(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('thingiverse.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  for (const seg of parts) {
    const m = seg.match(/^thing:(\d+)$/);
    if (m && m[1]) {
      return { sourceId: 'thingiverse', context: { kind: 'file', id: m[1] } };
    }
  }

  return null;
}

// ── Printables ───────────────────────────────────────────────────────────────

/**
 * Matches printables.com model URLs (with or without locale prefix):
 *   /model/{numericId}-{slug}
 *   /en/model/{numericId}-{slug}
 *   /{locale}/model/{numericId}-{slug}
 */
function matchPrintables(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('printables.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  const modelIdx = parts.indexOf('model');
  if (modelIdx !== -1) {
    const seg = pathSegment(parts, modelIdx + 1);
    if (seg) {
      // Segment may be "{numericId}-{slug}" or just "{numericId}"
      const m = seg.match(/^(\d+)/);
      if (m && m[1]) {
        return { sourceId: 'printables', context: { kind: 'file', id: m[1] } };
      }
    }
  }

  return null;
}

// ── MakerWorld ───────────────────────────────────────────────────────────────

/**
 * Matches makerworld.com model URLs (with locale prefix):
 *   /en/models/{numericId}
 *   /{locale}/models/{numericId}
 */
function matchMakerWorld(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('makerworld.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  const modelsIdx = parts.indexOf('models');
  if (modelsIdx !== -1) {
    const seg = pathSegment(parts, modelsIdx + 1);
    if (seg) {
      const m = seg.match(/^(\d+)/);
      if (m && m[1]) {
        return { sourceId: 'makerworld', context: { kind: 'file', id: m[1] } };
      }
    }
  }

  return null;
}

// ── Sketchfab ────────────────────────────────────────────────────────────────

/**
 * Matches sketchfab.com model URLs:
 *   /3d-models/{slug}-{uid}   — uid is a 32-char hex suffix
 *   /models/{uid}             — direct uid reference
 */
function matchSketchfab(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('sketchfab.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // /3d-models/{slug}-{uid}
  if (parts[0] === '3d-models' && parts[1]) {
    // uid is the last hyphen-delimited 32-char hex segment
    const seg = parts[1];
    const m = seg.match(/-([0-9a-f]{32})$/i);
    if (m && m[1]) {
      return { sourceId: 'sketchfab', context: { kind: 'file', id: m[1].toLowerCase() } };
    }
    // No uid suffix — use the whole slug as id
    return { sourceId: 'sketchfab', context: { kind: 'file', id: seg } };
  }

  // /models/{uid}
  if (parts[0] === 'models' && parts[1]) {
    return { sourceId: 'sketchfab', context: { kind: 'file', id: parts[1] } };
  }

  return null;
}

// ── Patreon ──────────────────────────────────────────────────────────────────

/**
 * Matches patreon.com URLs:
 *   /posts/{slug}-{numericId}  → id = numericId
 *   /{creator}                 → campaign URL; id undefined
 */
function matchPatreon(parsed: URL): MatchResult {
  const host = parsed.hostname.toLowerCase();
  if (!host.includes('patreon.com')) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);

  // /posts/{slug}-{numericId} or /posts/{numericId}
  if (parts[0] === 'posts' && parts[1]) {
    const seg = parts[1];
    // Try to extract trailing numeric id from "{slug}-{id}" or just "{id}"
    const m = seg.match(/-(\d+)$/) ?? seg.match(/^(\d+)$/);
    if (m && m[1]) {
      return { sourceId: 'patreon', context: { kind: 'file', id: m[1] } };
    }
    return { sourceId: 'patreon', context: { kind: 'file', id: seg } };
  }

  // /{creator} — campaign page. A creator campaign is a container (not a file),
  // so return kind='folder' and use the creator handle as the id.
  if (parts.length === 1 && parts[0]) {
    return { sourceId: 'patreon', context: { kind: 'folder', id: parts[0] } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Ordered list of matcher functions
// ---------------------------------------------------------------------------

type Matcher = (parsed: URL) => MatchResult;

const MATCHERS: Matcher[] = [
  matchGoogleDrive,
  matchMega,
  matchMyMiniFactory,
  matchCults3D,
  matchThingiverse,
  matchPrintables,
  matchMakerWorld,
  matchSketchfab,
  matchPatreon,
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a LinkResolver instance.
 *
 * The resolver is stateless — all methods are pure functions over the URL input.
 * No network calls, no filesystem access, no DB.
 */
export function createLinkResolver(): LinkResolver {
  function resolve(url: string): LinkResolution {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { kind: 'unknown', rawUrl: url };
    }

    for (const matcher of MATCHERS) {
      const result = matcher(parsed);
      if (result !== null) {
        const normalized = normalizeUrl(url);
        if (normalized === null) {
          // Extremely unlikely if URL() parsed OK, but handle defensively.
          return { kind: 'unknown', rawUrl: url };
        }
        const resolution: LinkResolution = {
          kind: 'known',
          sourceId: result.sourceId,
          normalizedUrl: normalized,
        };
        if (result.context !== undefined) {
          (resolution as { kind: 'known'; sourceId: SourceId; normalizedUrl: string; context?: LinkContext }).context =
            result.context;
        }
        return resolution;
      }
    }

    return { kind: 'unknown', rawUrl: url };
  }

  function scan(text: string): LinkResolution[] {
    if (!text) return [];

    // Greedy URL pattern — captures http(s) URLs, stops at whitespace and
    // common HTML/Markdown delimiters.
    const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

    const seen = new Set<string>();
    const results: LinkResolution[] = [];

    let match: RegExpExecArray | null;
    while ((match = URL_RE.exec(text)) !== null) {
      const rawUrl = match[0];
      // Strip any trailing punctuation that was probably sentence punctuation,
      // not part of the URL (e.g. trailing periods and commas).
      const cleaned = rawUrl.replace(/[.,;:!?]+$/, '');

      const resolution = resolve(cleaned);
      const key = resolution.kind === 'known' ? resolution.normalizedUrl : resolution.rawUrl;

      if (!seen.has(key)) {
        seen.add(key);
        results.push(resolution);
      }
    }

    return results;
  }

  return { resolve, scan };
}
