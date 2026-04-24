/**
 * classifier.ts — Classifier interface + consensus combiner — V2-002-T6
 *
 * The Classifier takes a set of files (a single Loot candidate) and infers
 * metadata: title, creator, license, tags, description, primaryFormat, etc.
 * Each field carries a per-field confidence score (0–1).
 *
 * Architecture:
 *   - Multiple ClassifierProviders are registered; each returns a partial
 *     PartialClassification with per-field confidences.
 *   - The consensus combiner picks the highest-confidence provider per field.
 *   - Fields below the threshold AND required fields with no evidence go into
 *     needsUserInput so the caller can surface them for user confirmation.
 *
 * ADR-010: v2 ships ONLY the rules-based provider set. AI providers are
 * reserved extension points — this interface is designed to accommodate them
 * (async, provider-agnostic) but does not include any stubs.
 */

import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single inferred metadata field with its confidence and originating
 * provider. Used by callers to decide whether to auto-apply or surface for
 * user confirmation (confidence < 0.5 is conventionally "likely a guess").
 */
export type ClassifiedField<T> = {
  value: T;
  /** 0 (no evidence) to 1 (certain). Under 0.5 = likely guess, surface to user. */
  confidence: number;
  /** Which provider produced this. For debugging + conflict resolution. */
  source: string;
};

/**
 * The combined result from all providers. Fields that no provider could
 * confidently infer are either absent or listed in needsUserInput.
 */
export type ClassificationResult = {
  title?: ClassifiedField<string>;
  creator?: ClassifiedField<string>;
  description?: ClassifiedField<string>;
  license?: ClassifiedField<string>;
  tags?: ClassifiedField<string[]>;
  /** Primary content format (e.g. 'stl', '3mf', 'step'). */
  primaryFormat?: ClassifiedField<string>;
  /**
   * Fields the classifier could NOT confidently infer and need user input.
   * Caller MUST populate these before persisting as Loot.
   *
   * Example: ['title'] means the classifier couldn't determine a title.
   * This is DISTINCT from an empty/missing field — the classifier made a
   * deliberate "needs-user-input" verdict per ADR-010 constraint.
   */
  needsUserInput: Array<keyof ClassificationResult | string>;
};

/**
 * A single file in the Loot candidate. The classifier gets paths + sizes,
 * NOT the file bytes — providers that need bytes open and read the file
 * themselves (e.g. the 3MF provider unzips the file at the given absolute
 * path). This keeps the interface small and lazy-readable.
 */
export type ClassifierInput = {
  /**
   * Loot candidate — a set of files the caller believes belong together
   * (e.g. a folder of STL + PNG + README, or a single 3MF package).
   */
  files: Array<{
    absolutePath: string;
    relativePath: string; // relative to the stash root
    size: number;
    mtime: Date;
  }>;
  /**
   * Optional: the containing folder path relative to the stash root.
   * Some providers (folder-pattern inference) need this.
   */
  folderRelativePath?: string;
};

/**
 * A provider returns a partial ClassificationResult. Null/absent fields mean
 * "I have no evidence for this field"; providers must NOT guess.
 *
 * Returned confidence + source go into the consensus combiner.
 */
export type ClassifierProvider = {
  /** Identifier, used for ClassifiedField.source and debugging. */
  name: string;
  classify(input: ClassifierInput): Promise<PartialClassification>;
};

/** What a single provider returns. */
export type PartialClassification = {
  title?: { value: string; confidence: number };
  creator?: { value: string; confidence: number };
  description?: { value: string; confidence: number };
  license?: { value: string; confidence: number };
  tags?: { value: string[]; confidence: number };
  primaryFormat?: { value: string; confidence: number };
};

/** Main orchestrator. */
export type Classifier = {
  classify(input: ClassifierInput): Promise<ClassificationResult>;
};

export type ClassifierOptions = {
  providers: ClassifierProvider[];
  /**
   * Confidence threshold below which a field is marked needs_user_input.
   * Default 0.4 — if the best provider's confidence is below this AND no
   * provider reached threshold, the field goes to needsUserInput rather
   * than being silently populated.
   */
  confidenceThreshold?: number;
  /**
   * Required fields — if absent from all providers, added to needsUserInput
   * even without reaching threshold. Defaults to ['title'].
   */
  requiredFields?: Array<keyof PartialClassification>;
};

// ---------------------------------------------------------------------------
// Scalar field keys (excludes tags which has special union semantics)
// ---------------------------------------------------------------------------

const SCALAR_FIELDS = [
  'title',
  'creator',
  'description',
  'license',
  'primaryFormat',
] as const satisfies ReadonlyArray<keyof PartialClassification>;

type ScalarField = (typeof SCALAR_FIELDS)[number];

// ---------------------------------------------------------------------------
// createClassifier — consensus combiner
// ---------------------------------------------------------------------------

/**
 * Creates a Classifier that runs all registered providers and combines their
 * outputs via confidence-weighted consensus:
 *
 *   Scalar fields: pick the highest-confidence provider wholesale.
 *   Tags field: UNION of all providers (deduped, confidence = max contributor).
 *
 * Fields below the threshold are left undefined.
 * Required fields with no qualifying evidence → added to needsUserInput.
 */
export function createClassifier(options: ClassifierOptions): Classifier {
  const {
    providers,
    confidenceThreshold = 0.4,
    requiredFields = ['title'],
  } = options;

  return {
    async classify(input: ClassifierInput): Promise<ClassificationResult> {
      // Run all providers concurrently. Use allSettled so a single provider's
      // failure (malformed file, library bug, etc.) does not take down the
      // whole classification — remaining providers still contribute.
      const settled = await Promise.allSettled(
        providers.map(async (provider) => {
          const partial = await provider.classify(input);
          return { name: provider.name, partial };
        }),
      );

      const providerOutputs: Array<{ name: string; partial: PartialClassification }> = [];
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          providerOutputs.push(s.value);
        } else {
          // Providers should log their own parse errors internally (e.g. 3MF's
          // jszip warn); this outer guardrail catches anything they let escape.
          logger.warn(
            { err: s.reason },
            'classifier: provider threw; continuing with remaining providers',
          );
        }
      }

      const result: ClassificationResult = { needsUserInput: [] };

      // ── Scalar fields ────────────────────────────────────────────────────
      for (const field of SCALAR_FIELDS) {
        // Collect evidence from all providers.
        let bestConfidence = -1;
        let bestValue: string | undefined;
        let bestSource: string | undefined;

        for (const { name, partial } of providerOutputs) {
          const evidence = partial[field];
          if (evidence == null) continue;
          if (evidence.confidence > bestConfidence) {
            bestConfidence = evidence.confidence;
            bestValue = evidence.value;
            bestSource = name;
          }
        }

        if (bestValue !== undefined && bestConfidence >= confidenceThreshold) {
          (result as Record<string, unknown>)[field] = {
            value: bestValue,
            confidence: bestConfidence,
            source: bestSource!,
          } satisfies ClassifiedField<string>;
        }
        // Below threshold: field stays undefined.
      }

      // ── Tags field (union) ───────────────────────────────────────────────
      const tagSets: { value: string[]; confidence: number; name: string }[] = [];
      for (const { name, partial } of providerOutputs) {
        if (partial.tags != null) {
          tagSets.push({ ...partial.tags, name });
        }
      }

      if (tagSets.length > 0) {
        const allTags = new Set<string>();
        let maxConfidence = 0;
        let maxSource = '';
        for (const ts of tagSets) {
          for (const t of ts.value) allTags.add(t);
          if (ts.confidence > maxConfidence) {
            maxConfidence = ts.confidence;
            maxSource = ts.name;
          }
        }

        if (maxConfidence >= confidenceThreshold && allTags.size > 0) {
          result.tags = {
            value: Array.from(allTags),
            confidence: maxConfidence,
            source: maxSource,
          };
        }
      }

      // ── needsUserInput — required fields ─────────────────────────────────
      for (const field of requiredFields) {
        if ((result as Record<string, unknown>)[field] === undefined) {
          if (!result.needsUserInput.includes(field)) {
            result.needsUserInput.push(field);
          }
        }
      }

      return result;
    },
  };
}
