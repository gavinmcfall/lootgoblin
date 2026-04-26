/**
 * path-template.ts — Pure-function template engine for Stash path resolution.
 *
 * Resolves mustache-style templates like:
 *   {creator|slug}/{title|slug}/{license|sanitize|truncate:60}
 *
 * No filesystem access. No DB access. No external dependencies.
 * Usable from workers, API routes, and preview endpoints.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemplateField = {
  name: string;
  transforms: string[];
};

export type ParsedTemplate = {
  raw: string;
  segments: Array<
    Array<
      | { kind: 'literal'; value: string }
      | { kind: 'field'; field: TemplateField }
    >
  >;
};

export type TargetOS = 'linux' | 'macos' | 'windows';

export type ResolveInput = {
  metadata: Record<string, unknown>;
  targetOS: TargetOS;
};

export type ResolveReason =
  | 'missing-field'
  | 'forbidden-character'
  | 'reserved-name'
  | 'path-too-long'
  | 'segment-too-long'
  | 'empty-segment'
  | 'unknown-transform';

export type ResolveVerdict =
  | { ok: true; path: string }
  | { ok: false; reason: ResolveReason; details: string };

// ---------------------------------------------------------------------------
// OS-aware validation tables
// ---------------------------------------------------------------------------

const FORBIDDEN_CHARS: Record<TargetOS, RegExp> = {
  linux: /[\0/]/,
  macos: /[\0/:]/,
  windows: /[\0<>:"/\\|?*\x00-\x1f]/,
};

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_TOTAL_PATH: Record<TargetOS, number> = {
  linux: 4096,
  macos: 1024,
  windows: 260,
};

const MAX_SEGMENT_BYTES = 255;

// ---------------------------------------------------------------------------
// Transform registry
// ---------------------------------------------------------------------------

/**
 * Slug: NFKD-decompose → strip combining marks → lowercase →
 *       replace non-alphanumeric runs with "-" → trim leading/trailing "-".
 */
function applySlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Sanitize: replace any char forbidden on Windows or macOS with "_",
 * then collapse runs of "_". Does NOT lowercase or transliterate.
 */
function applySanitize(value: string): string {
  // Union of Windows + macOS forbidden chars (excluding NUL which is already illegal)
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Build a truncate transform function for a given N.
 * Operates on Unicode code points, not UTF-16 chars.
 */
function buildTruncate(n: number): (value: string) => string {
  return (value: string) => [...value].slice(0, n).join('');
}

/**
 * Parse a transform spec like "truncate:60" into a callable.
 * Returns null if the spec is unrecognised or malformed.
 */
function resolveTransformFn(spec: string): ((v: string) => string) | null {
  if (spec === 'slug') return applySlug;
  if (spec === 'lowercase') return (v) => v.toLowerCase();
  if (spec === 'uppercase') return (v) => v.toUpperCase();
  if (spec === 'sanitize') return applySanitize;

  const truncMatch = /^truncate:(\d+)$/.exec(spec);
  if (truncMatch) {
    const n = parseInt(truncMatch[1] ?? '', 10);
    if (n > 0) return buildTruncate(n);
    return null; // truncate:0 or negative — invalid
  }

  return null;
}

/**
 * Exposed for tests only. Provides named callable transforms.
 * Keys include dynamic "truncate:N" variants on demand.
 */
export const __transforms: Record<string, (v: string) => string> = new Proxy(
  {} as Record<string, (v: string) => string>,
  {
    get(_target, prop: string) {
      const fn = resolveTransformFn(prop);
      if (fn) return fn;
      return undefined;
    },
    has(_target, prop: string) {
      return resolveTransformFn(prop) !== null;
    },
  },
);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a segment string (the text between "/" separators) into a list of
 * literal and field parts. A segment can be a mix, e.g. "prefix-{title}-suffix"
 * (though the task brief only exercises pure-literal or pure-field segments).
 */
function parseSegment(
  raw: string,
  segIndex: number,
): ParsedTemplate['segments'][number] {
  const parts: ParsedTemplate['segments'][number] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '}') {
      throw new Error(`Unexpected '}' at position ${i} in segment "${raw}" (segment ${segIndex})`);
    }
    if (raw[i] === '{') {
      // Check for double-open: {{ → next char is also '{'
      if (raw[i + 1] === '{') {
        throw new Error(`Double opening brace '{{' at position ${i} in segment "${raw}"`);
      }
      const closeIdx = raw.indexOf('}', i + 1);
      if (closeIdx === -1) {
        throw new Error(`Unclosed '{' at position ${i} in segment "${raw}"`);
      }
      const inner = raw.slice(i + 1, closeIdx);
      if (inner.length === 0) {
        throw new Error(`Empty field '{}' at position ${i} in segment "${raw}"`);
      }
      // Inner may contain another '{' or '}'
      if (inner.includes('{') || inner.includes('}')) {
        throw new Error(`Nested braces not allowed in field at position ${i} in segment "${raw}"`);
      }
      const [fieldName, ...transformParts] = inner.split('|');
      if (!fieldName || fieldName.trim().length === 0) {
        throw new Error(`Empty field name in '${raw}' at position ${i}`);
      }
      const transforms = transformParts.map((t) => t.trim()).filter((t) => t.length > 0);

      // Parse-time validation: truncate:<arg> must have a positive integer arg.
      // Bare `truncate` (no colon) stays unknown-transform at resolve time per spec.
      for (const spec of transforms) {
        if (spec.startsWith('truncate:')) {
          const argStr = spec.slice('truncate:'.length);
          if (argStr.length === 0) {
            throw new Error(`Transform "${spec}" missing argument (expected positive integer)`);
          }
          // Require all digits (no signs, no floats, no letters)
          if (!/^\d+$/.test(argStr)) {
            throw new Error(`Transform "${spec}" has non-integer argument "${argStr}"`);
          }
          const n = parseInt(argStr, 10);
          if (n <= 0) {
            throw new Error(`Transform "${spec}" argument must be > 0, got ${n}`);
          }
        }
      }

      parts.push({
        kind: 'field',
        field: {
          name: fieldName.trim(),
          transforms,
        },
      });
      i = closeIdx + 1;
    } else {
      // Consume literal chars
      let literalEnd = i;
      while (literalEnd < raw.length && raw[literalEnd] !== '{' && raw[literalEnd] !== '}') {
        literalEnd++;
      }
      parts.push({ kind: 'literal', value: raw.slice(i, literalEnd) });
      i = literalEnd;
    }
  }
  return parts;
}

export function parseTemplate(template: string): ParsedTemplate {
  if (template.length === 0) {
    throw new Error('Template must not be empty');
  }
  if (template.startsWith('/')) {
    throw new Error('Template must not start with a slash');
  }
  if (template.endsWith('/')) {
    throw new Error('Template must not end with a slash');
  }
  if (template.includes('//')) {
    throw new Error('Template must not contain consecutive slashes');
  }

  const rawSegments = template.split('/');
  const segments: ParsedTemplate['segments'] = rawSegments.map((seg, idx) =>
    parseSegment(seg, idx),
  );

  return { raw: template, segments };
}

// ---------------------------------------------------------------------------
// Static validation (no metadata needed)
// ---------------------------------------------------------------------------

/** Check if a literal segment value is a Windows reserved name (case-insensitive, ignore extension). */
function isWindowsReserved(value: string): boolean {
  const stem = (value.split('.')[0] ?? '').toUpperCase();
  return WINDOWS_RESERVED.has(stem);
}

export function validateTemplate(
  parsed: ParsedTemplate,
  targetOS: TargetOS,
): Exclude<ResolveVerdict, { ok: true }> | null {
  for (const segment of parsed.segments) {
    // Reserved-name is a whole-segment property. Only check it when the segment
    // is a single pure-literal part (e.g. `CON/{title}`). For mixed segments
    // like `CON{ext}` the final assembled value (`CONsomething`) may not be
    // reserved — so defer that check to resolveTemplate where the real segment
    // string is known. Otherwise validate and resolve would disagree.
    const firstPart = segment[0];
    if (
      targetOS === 'windows' &&
      segment.length === 1 &&
      firstPart &&
      firstPart.kind === 'literal' &&
      isWindowsReserved(firstPart.value)
    ) {
      return {
        ok: false,
        reason: 'reserved-name',
        details: `Literal segment "${firstPart.value}" is a Windows reserved name`,
      };
    }

    for (const part of segment) {
      if (part.kind === 'literal') {
        // Check forbidden chars in literal — char-level property, safe per-part.
        if (FORBIDDEN_CHARS[targetOS].test(part.value)) {
          return {
            ok: false,
            reason: 'forbidden-character',
            details: `Literal segment "${part.value}" contains a character forbidden on ${targetOS}`,
          };
        }
      } else {
        // Check all transform specs are known
        for (const spec of part.field.transforms) {
          if (resolveTransformFn(spec) === null) {
            return {
              ok: false,
              reason: 'unknown-transform',
              details: `Transform "${spec}" is not registered`,
            };
          }
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function coerceToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.join('-');
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

export function resolveTemplate(parsed: ParsedTemplate, input: ResolveInput): ResolveVerdict {
  const { metadata, targetOS } = input;
  const resolvedSegments: string[] = [];

  for (const segment of parsed.segments) {
    let segmentValue = '';

    for (const part of segment) {
      if (part.kind === 'literal') {
        segmentValue += part.value;
      } else {
        const { name, transforms } = part.field;
        const raw = metadata[name];
        const coerced = coerceToString(raw);
        if (coerced === null) {
          return {
            ok: false,
            reason: 'missing-field',
            details: `field '${name}' missing`,
          };
        }

        // Apply transforms in order
        let value = coerced;
        for (const spec of transforms) {
          const fn = resolveTransformFn(spec);
          if (fn === null) {
            return {
              ok: false,
              reason: 'unknown-transform',
              details: `Transform "${spec}" is not registered`,
            };
          }
          value = fn(value);
        }
        segmentValue += value;
      }
    }

    // Check empty segment
    if (segmentValue.length === 0) {
      return {
        ok: false,
        reason: 'empty-segment',
        details: 'A path segment resolved to an empty string',
      };
    }

    // Check forbidden characters in resolved segment
    if (FORBIDDEN_CHARS[targetOS].test(segmentValue)) {
      return {
        ok: false,
        reason: 'forbidden-character',
        details: `Resolved segment "${segmentValue}" contains a character forbidden on ${targetOS}`,
      };
    }

    // Check Windows reserved names
    if (targetOS === 'windows' && isWindowsReserved(segmentValue)) {
      return {
        ok: false,
        reason: 'reserved-name',
        details: `Resolved segment "${segmentValue}" is a Windows reserved name`,
      };
    }

    // Check segment byte length
    if (utf8ByteLength(segmentValue) > MAX_SEGMENT_BYTES) {
      return {
        ok: false,
        reason: 'segment-too-long',
        details: `Segment "${segmentValue.slice(0, 40)}..." exceeds ${MAX_SEGMENT_BYTES} bytes`,
      };
    }

    resolvedSegments.push(segmentValue);
  }

  // Assemble final path (forward slashes, no leading/trailing slash)
  const path = resolvedSegments.join('/');

  // Check total path length.
  // Unit depends on target OS:
  //   - linux (PATH_MAX = 4096) and macOS (typical 1024) measure bytes (UTF-8).
  //   - windows (MAX_PATH = 260) measures UTF-16 code units.
  // String.prototype.length gives UTF-16 code units, so it's correct only for
  // windows. linux + macos need TextEncoder byte length.
  const pathLength = targetOS === 'windows' ? path.length : utf8ByteLength(path);
  if (pathLength > MAX_TOTAL_PATH[targetOS]) {
    return {
      ok: false,
      reason: 'path-too-long',
      details: `Resolved path length ${pathLength} exceeds ${MAX_TOTAL_PATH[targetOS]} for ${targetOS}`,
    };
  }

  return { ok: true, path };
}
