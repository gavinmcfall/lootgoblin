export interface NamingContext {
  title: string;
  designer: string;
  collection?: string;
  category?: string;
}

const UNSAFE_CHARS = /[\\/:*?"<>|]/g;

export function sanitizePathSegment(raw: string): string {
  let out = raw.replace(UNSAFE_CHARS, '-').trim().replace(/\s+/g, ' ');
  // Trim trailing dots/spaces (Windows hostility) and collapse repeats of '-'
  out = out.replace(/[-]{2,}/g, '-').replace(/[.\s]+$/g, '');
  if (!out || /^\.+$/.test(out)) out = '_';
  return out;
}

const TOKEN_RE = /\{([a-z_]+)(\?)?\}/g;

export function expandTemplate(template: string, ctx: NamingContext): string {
  const expanded = template.replace(TOKEN_RE, (_m, name: string, optional?: string) => {
    const value = (ctx as Record<string, string | undefined>)[name];
    if (value === undefined) {
      if (optional) return '';
      throw new Error(`Unknown token: ${name}`);
    }
    return sanitizePathSegment(String(value));
  });
  // Collapse doubled slashes that appear from optional empties
  return expanded.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
