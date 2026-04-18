export interface SourceCapabilities {
  id: string;
  displayName: string;
  triggerModes: Array<'browse-tag' | 'url-paste' | 'feed-poll'>;
  contentTypes: string[];
  authKind: 'cookie-jar' | 'oauth-token' | 'api-key' | 'none';
  defaultRateLimitPerSec: number;
}

export interface FetchedFile {
  name: string;
  stream: NodeJS.ReadableStream;
  size?: number;
  mediaType: string;
}

export interface FetchedItem {
  sourceItemId: string;
  title: string;
  description: string;
  designer: { name: string; profileUrl?: string };
  collection?: { name: string; url?: string };
  tags: string[];
  license: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  images: Array<{ name: string; url: string }>;
  files: FetchedFile[];
  extraMetadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  capabilities: SourceCapabilities;
  fetch(sourceItemId: string, credentialBlob: string): Promise<FetchedItem>;
  verifyCredential(blob: string): Promise<{ ok: boolean; accountLabel?: string }>;
  siteConfig(): import('../lib/site-configs').SiteConfig;
}
