import { api } from './api-client';
import { Storage } from './storage';
import type { SiteConfig } from '@/types/site-config';

const TTL_MS = 10 * 60_000;

export async function getSiteConfigs(): Promise<SiteConfig[]> {
  const cached = await Storage.getSiteConfigs();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return cached.configs as SiteConfig[];
  }
  try {
    const fresh = await api<{ configs: SiteConfig[]; interpreterVersion: number }>('/api/v1/site-configs');
    await Storage.setSiteConfigs({ configs: fresh.configs, fetchedAt: Date.now() });
    return fresh.configs;
  } catch {
    return (cached?.configs as SiteConfig[]) ?? [];
  }
}

export function findMatchingConfig(url: string, configs: SiteConfig[]): SiteConfig | undefined {
  return configs.find((c) => c.matches.some((p) => matchGlob(p, url)));
}

function matchGlob(pattern: string, url: string): boolean {
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return re.test(url);
}
