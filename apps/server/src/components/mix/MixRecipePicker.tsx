'use client';
// MixRecipePicker — step 0 of the Guided Mix wizard. Lists the caller's mix
// recipes; choosing one enters the wizard at step 1. No recipe-create UI is in
// scope (recipes are authored via the API for now).

import { useQuery } from '@tanstack/react-query';
import { EmptyHint } from '@/components/shell/atoms';
import type { MixRecipeDto } from './types';

export function MixRecipePicker({
  onSelect,
}: {
  onSelect: (recipe: MixRecipeDto) => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['mix-recipes'],
    queryFn: async (): Promise<{ recipes: MixRecipeDto[] }> =>
      (await fetch('/api/v1/materials/mix-recipes')).json(),
  });

  if (isError) return <EmptyHint>Failed to load mix recipes.</EmptyHint>;
  if (isLoading) return <EmptyHint>Loading recipes…</EmptyHint>;

  const recipes = data?.recipes ?? [];

  if (recipes.length === 0) {
    return (
      <EmptyHint>No mix recipes yet — recipes are authored via the API for now.</EmptyHint>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-hairline bg-surface">
      <div className="border-b border-hairline bg-surface-2 px-[18px] py-3 font-mono text-[9.5px] uppercase tracking-[1.4px] text-fg-faint">
        Pick a recipe to mix
      </div>
      {recipes.map((r, idx) => {
        const total = r.components.reduce((s, c) => s + c.ratioOrGrams, 0);
        const isLast = idx === recipes.length - 1;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(r)}
            className={`flex w-full items-center gap-4 px-[18px] py-3.5 text-left transition-colors hover:bg-surface-hi ${
              isLast ? '' : 'border-b border-dashed border-hairline'
            }`}
          >
            <span className="flex-1">
              <span className="font-serif text-[17px] italic text-fg">{r.name}</span>
              {r.notes && (
                <span className="mt-0.5 block font-sans text-[12px] text-fg-muted">
                  {r.notes}
                </span>
              )}
            </span>
            <span className="font-mono text-[10.5px] text-fg-faint">
              {r.components.length} components
            </span>
            <span className="font-serif text-[18px] italic text-fg">
              {total}
              <span className="ml-0.5 font-mono text-[10px] not-italic text-fg-faint">g</span>
            </span>
            <span className="font-mono text-[12px] text-fg-faint">›</span>
          </button>
        );
      })}
    </div>
  );
}
