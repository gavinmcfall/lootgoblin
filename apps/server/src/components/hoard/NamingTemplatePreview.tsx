// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';

export function NamingTemplatePreview({ template }: { template: string }) {
  const sample: Record<string, string> = {
    title: 'Elven Ranger Bust',
    designer: 'Bulka Mancer',
    collection: 'Fantasy',
    category: 'Busts',
  };
  let preview: string;
  try {
    preview = template.replace(/\{([a-z_]+)\??\}/g, (_m, k) => sample[k] ?? '');
  } catch {
    preview = '(invalid template)';
  }
  return (
    <div className="rounded-md bg-surface-2 border border-hairline p-3 text-xs font-mono text-accent">
      Preview: {preview || '(empty)'}
    </div>
  );
}
