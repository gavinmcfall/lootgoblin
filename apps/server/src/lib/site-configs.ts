// apps/server/src/lib/site-configs.ts — full impl in B-4
export interface SiteConfig {
  siteId: string;
  interpreterVersion: number;
  matches: string[];
  triggers: Array<{
    name: string;
    selector: string;
    extract: Record<string, { selector?: string; attr?: string; text?: boolean; regex?: string }>;
    inject: { button?: { template: string; position: string; label: string } };
  }>;
}
