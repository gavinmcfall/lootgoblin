import fs from 'node:fs/promises';
import path from 'node:path';
import { listAdapters } from '../adapters';

export interface ExtractRule {
  selector?: string;
  attr?: string;
  text?: boolean;
  regex?: string;
}

export interface Trigger {
  name: string;
  selector: string;
  // Optional per-trigger URL glob patterns — if set, trigger only runs when
  // the page URL matches. Interpreter version 1+ supports this field.
  urlMatch?: string[];
  extract: Record<string, ExtractRule>;
  inject: { button?: { template: string; position: string; label: string } };
}

export interface SiteConfig {
  siteId: string;
  interpreterVersion: number;
  matches: string[];
  triggers: Trigger[];
}

function getConfigDir(): string {
  return process.env.SITE_CONFIGS_DIR ?? '/config/site-configs';
}

export async function loadSiteConfigs(): Promise<SiteConfig[]> {
  const fromCode = listAdapters().map((a) => a.siteConfig());
  const fromDisk: SiteConfig[] = [];
  try {
    const files = await fs.readdir(getConfigDir());
    for (const f of files.filter((n) => n.endsWith('.json'))) {
      const raw = await fs.readFile(path.join(getConfigDir(), f), 'utf8');
      fromDisk.push(JSON.parse(raw) as SiteConfig);
    }
  } catch {
    /* dir may not exist yet */
  }
  // Disk overrides code, keyed by siteId
  const merged = new Map<string, SiteConfig>();
  for (const c of fromCode) merged.set(c.siteId, c);
  for (const c of fromDisk) merged.set(c.siteId, c);
  return [...merged.values()];
}
