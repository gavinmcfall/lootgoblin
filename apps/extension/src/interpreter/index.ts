import type { SiteConfig, Trigger } from '@/types/site-config';
import { extract } from './extract';
import { inject } from './inject';
import { bc } from '@/lib/browser-compat';

const INTERPRETER_VERSION = 1;

export function runInterpreter(config: SiteConfig): void {
  if (config.interpreterVersion > INTERPRETER_VERSION) {
    console.warn(
      `[lootgoblin] site-config for ${config.siteId} requires interpreter v${config.interpreterVersion}; skipping`,
    );
    return;
  }
  const apply = () => {
    for (const trigger of config.triggers) applyTrigger(config, trigger);
  };
  apply();
  const observer = new MutationObserver(() => apply());
  observer.observe(document.body, { subtree: true, childList: true });
}

function applyTrigger(config: SiteConfig, trigger: Trigger): void {
  const roots = document.querySelectorAll<HTMLElement>(trigger.selector);
  roots.forEach((root) => {
    const data = extract(root, trigger.extract);
    inject(root, trigger.inject, () => onTagClick(config, data));
  });
}

async function onTagClick(config: SiteConfig, data: Record<string, string | null>): Promise<void> {
  const payload = {
    sourceId: config.siteId,
    sourceItemId: String(data.modelId ?? ''),
    sourceUrl: location.href,
    contentType: 'model-3d',
    snapshot: data,
  };
  const res = (await bc.runtime.sendMessage({ type: 'queue-tag', payload })) as
    | { ok: true; data: { id?: string; duplicate?: boolean; existingId?: string } }
    | { ok: false; error: string };
  if (res && 'ok' in res && res.ok) {
    const data = res.data as { duplicate?: boolean; existingId?: string };
    if (data.duplicate) {
      flash('already in library');
    } else {
      flash('queued ✓');
    }
  } else {
    const err = res && 'error' in res ? res.error : 'unknown error';
    flash('error: ' + err);
  }
}

function flash(text: string): void {
  const div = document.createElement('div');
  div.textContent = 'LootGoblin: ' + text;
  div.style.cssText =
    'position:fixed;bottom:16px;right:16px;z-index:99999;background:#064e3b;color:#a7f3d0;padding:8px 12px;border-radius:6px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 2500);
}
