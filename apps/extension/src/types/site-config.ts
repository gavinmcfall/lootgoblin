export interface ExtractRule {
  selector?: string;       // optional; defaults to root element
  attr?: string;           // extracts attribute
  text?: boolean;          // extracts textContent
  regex?: string;          // applied to extracted value; first capture group returned
}

export interface Trigger {
  name: string;
  selector: string;
  // Optional: per-trigger URL patterns (glob-style with `*`). If set, the trigger
  // only runs when the current page URL matches at least one pattern. If unset,
  // the trigger runs everywhere the site-config matches.
  urlMatch?: string[];
  extract: Record<string, ExtractRule>;
  inject: { button?: { template: string; position: 'append' | 'prepend' | 'topbar'; label: string } };
}

export interface SiteConfig {
  siteId: string;
  interpreterVersion: number;
  matches: string[];
  triggers: Trigger[];
}
