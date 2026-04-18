import type { ExtractRule } from '@/types/site-config';

export function extract(root: Element, rules: Record<string, ExtractRule>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const target = rule.selector ? root.querySelector(rule.selector) : root;
    if (!target) {
      out[key] = null;
      continue;
    }
    let value: string | null = null;
    if (rule.attr) value = target.getAttribute(rule.attr);
    else if (rule.text) value = target.textContent?.trim() ?? null;
    if (value && rule.regex) {
      const m = new RegExp(rule.regex).exec(value);
      value = m?.[1] ?? m?.[0] ?? null;
    }
    out[key] = value;
  }
  return out;
}
