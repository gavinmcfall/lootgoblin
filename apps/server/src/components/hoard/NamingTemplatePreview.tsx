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
    <div className="rounded bg-slate-900 p-3 text-xs font-mono text-emerald-300">
      Preview: {preview || '(empty)'}
    </div>
  );
}
