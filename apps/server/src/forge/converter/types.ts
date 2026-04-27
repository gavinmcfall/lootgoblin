/**
 * types.ts — V2-005b T_b1
 *
 * Shared types for the format-converter framework. Lives in its own file
 * so backend implementations (sharp-images, sevenzip-archives,
 * blender-mesh-stub) can import the result type without a circular dep
 * back to ./index.
 */

/**
 * Lowercased, dot-stripped format names recognized by the converter. Plus
 * the special 'archive-extract' sentinel for archive outputs (matches
 * TargetCompatibilityMatrix's ARCHIVE_EXTRACT_SENTINEL).
 *
 * Kept as a plain string union rather than a brand so callers don't have
 * to cast at every entry point — `normalizeFormat` does the runtime work.
 */
export type ConversionFormat =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'zip'
  | 'rar'
  | '7z'
  | 'stl'
  | '3mf'
  | 'obj'
  | 'fbx'
  | 'glb'
  | 'archive-extract';

export type ConversionFailureReason =
  /** Required external tool (7z, blender) is not installed on the host. */
  | 'missing-tool'
  /** No conversion path exists for this (input, output) pair. */
  | 'unsupported-pair'
  /** Input file does not exist, is unreadable, or has the wrong format. */
  | 'invalid-input'
  /** External tool ran but exited non-zero or rejected the input. */
  | 'tool-failed'
  /** Stub backend (e.g. Blender mesh in T_b1 before T_b2 lands). */
  | 'not-implemented'
  /** Archive extracted but only system metadata files came out. */
  | 'archive-no-usable-content';

export type ConversionResult =
  | {
      ok: true;
      /** Single file for image/mesh; multiple for archive extraction. */
      outputPaths: string[];
      /** Echoes the input's outputFormat (or 'archive-extract' for archives). */
      outputFormat: string;
    }
  | {
      ok: false;
      reason: ConversionFailureReason;
      /** Human-readable detail for logs / UI surfacing. */
      details?: string;
      /** Set when reason='missing-tool'. */
      toolName?: string;
      /** Set when reason='missing-tool': platform-aware install hint. */
      installHint?: string;
    };
