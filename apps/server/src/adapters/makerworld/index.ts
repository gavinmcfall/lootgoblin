import type { SourceAdapter, FetchedItem } from '../types';
import { mwFetch, BotChallengeError, CredentialInvalidError, PermissionDeniedError } from './api';
import { mwSiteConfig } from './site-config';

const MW_BASE = 'https://makerworld.com';

// ── Capability declaration ─────────────────────────────────────────────────

const capabilities: SourceAdapter['capabilities'] = {
  id: 'makerworld',
  displayName: 'MakerWorld',
  triggerModes: ['browse-tag'],
  contentTypes: ['model-3d'],
  authKind: 'cookie-jar',
  defaultRateLimitPerSec: 0.5,
};

// ── fetchMetadata ─────────────────────────────────────────────────────────

async function fetchMetadataOnly(
  sourceItemId: string,
  credentialBlob: string,
): Promise<Record<string, unknown>> {
  const designRes = await mwFetch(
    `${MW_BASE}/api/v1/design-service/design/${sourceItemId}`,
    credentialBlob,
  );
  return (await designRes.json()) as Record<string, unknown>;
}

// ── fetch ─────────────────────────────────────────────────────────────────

async function fetchItem(
  sourceItemId: string,
  credentialBlob: string,
): Promise<FetchedItem> {
  // 1. Design metadata
  const designRes = await mwFetch(
    `${MW_BASE}/api/v1/design-service/design/${sourceItemId}`,
    credentialBlob,
  );
  const design = (await designRes.json()) as MwDesign;

  // 2. Pick the default instance
  const defaultInstance =
    design.instances.find(i => i.id === design.defaultInstanceId) ??
    design.instances[0];

  if (!defaultInstance) {
    throw new Error(`Design ${sourceItemId} has no instances`);
  }

  // 3. Resolve f3mf signed URL — may return 418 (bot challenge)
  let f3mf: { name: string; url: string };
  try {
    const f3mfRes = await mwFetch(
      `${MW_BASE}/api/v1/design-service/instance/${defaultInstance.id}/f3mf`,
      credentialBlob,
    );
    f3mf = (await f3mfRes.json()) as { name: string; url: string };
  } catch (err) {
    if (err instanceof Error && (err as Error & { isBotChallenge?: boolean }).isBotChallenge) {
      throw new BotChallengeError([
        {
          url: `${MW_BASE}/api/v1/design-service/instance/${defaultInstance.id}/f3mf`,
          name: `${design.slug}.3mf`,
        },
      ]);
    }
    throw err;
  }

  // 4. Stream-fetch the signed CDN URL (CDN is anonymous but passing cookies is harmless)
  const fileResponse = await mwFetch(f3mf.url, credentialBlob);

  // 5. Map to FetchedItem
  const title =
    (design.titleTranslated?.trim() || design.title) ?? '';
  const description =
    (design.summaryTranslated?.trim() || design.summary) ?? '';
  const tags: string[] =
    design.tagsTranslated ?? design.tags ?? [];
  const license =
    typeof design.license === 'string'
      ? design.license
      : ((design.license as { code?: string })?.code ?? 'unknown');

  return {
    sourceItemId: String(design.id),
    title,
    description,
    designer: {
      name: design.designCreator.name,
      profileUrl: `https://makerworld.com/en/@${design.designCreator.handle}`,
    },
    collection: undefined,
    tags,
    license,
    sourceUrl: `https://makerworld.com/en/models/${design.id}-${design.slug}`,
    thumbnailUrl: design.coverUrl,
    images: [{ name: 'cover', url: design.coverUrl }],
    files: [
      {
        name: f3mf.name,
        mediaType: 'model/3mf',
        stream: fileResponse.body as unknown as NodeJS.ReadableStream,
      },
    ],
    extraMetadata: {
      defaultInstanceId: design.defaultInstanceId,
      categories: design.categories,
      modelId: design.modelId,
    },
  };
}

// ── verifyCredential ───────────────────────────────────────────────────────

async function verifyCredential(
  blob: string,
): Promise<{ ok: boolean; accountLabel?: string }> {
  try {
    await mwFetch(
      `${MW_BASE}/api/v1/design-user-service/my/preference`,
      blob,
    );
    return { ok: true, accountLabel: undefined };
  } catch (err) {
    if (
      err instanceof CredentialInvalidError ||
      err instanceof PermissionDeniedError
    ) {
      return { ok: false };
    }
    return { ok: false };
  }
}

// ── Adapter export ─────────────────────────────────────────────────────────

export const makerworld: SourceAdapter = {
  capabilities,
  fetch: fetchItem,
  fetchMetadata: fetchMetadataOnly,
  verifyCredential,
  siteConfig: mwSiteConfig,
};

// ── Internal types ─────────────────────────────────────────────────────────

interface MwCreator {
  uid: number;
  name: string;
  handle: string;
  avatar?: string;
}

interface MwInstance {
  id: number;
  profileId: number;
  title: string;
  titleTranslated?: string;
  summary?: string;
  summaryTranslated?: string;
  cover?: string;
  isDefault?: boolean;
  hasZipStl?: boolean;
  pictures?: Array<{ name: string; url: string }>;
}

interface MwCategory {
  id: number;
  name: string;
  parentId?: number;
}

interface MwDesign {
  id: number;
  slug: string;
  title: string;
  titleTranslated?: string | null;
  summary?: string;
  summaryTranslated?: string | null;
  coverUrl: string;
  tags?: string[];
  tagsTranslated?: string[];
  license: string | { code?: string };
  designCreator: MwCreator;
  categories?: MwCategory[];
  modelId?: string;
  instances: MwInstance[];
  defaultInstanceId: number;
}
