'use client';
// /materials/mix — Guided Mix (manual weight entry).
// Canvas: planning/design-system/exports/jsx/page-mix-manual.jsx (4 stages).
// Turned into a live 5-step wizard; the Map step (step 2) is added because the
// design lacks it (recipe components are abstract refs with no stored mapping).
//
// Wizard state lives here in useState. The route computes the POST body (mass-
// conservation invariant in draws.ts) and runs the mutation; the step
// components are presentational. See backend contract in
// apps/server/src/materials/mix.ts (applyMixBatch).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { MixStepper } from '@/components/mix/MixStepper';
import { MixRecipePicker } from '@/components/mix/MixRecipePicker';
import { MixRecipeCard } from '@/components/mix/MixRecipeCard';
import { MixSourceMap } from '@/components/mix/MixSourceMap';
import { MixManualEntry } from '@/components/mix/MixManualEntry';
import { MixReview } from '@/components/mix/MixReview';
import { MixComplete } from '@/components/mix/MixComplete';
import { buildDraws } from '@/components/mix/draws';
import { mixReasonMessage, synthesizeHex } from '@/components/mix/types';
import type { MaterialDto, MixRecipeDto } from '@/components/mix/types';

interface MixBatchResponse {
  mixBatchMaterialId: string;
}

export default function MixPage() {
  const queryClient = useQueryClient();

  // Wizard state.
  const [step, setStep] = useState(0);
  const [recipe, setRecipe] = useState<MixRecipeDto | null>(null);
  const [batchSize, setBatchSize] = useState(0);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [weights, setWeights] = useState<Record<number, string>>({});
  const [colorName, setColorName] = useState('');
  // One idempotency key per recipe-apply attempt; held in state so a
  // double-click reuses it (the route returns the prior batch).
  const [idempotencyKey, setIdempotencyKey] = useState('');
  // Captured source materials at map time so Review/Complete can resolve hex +
  // labels without a refetch. Keyed by id.
  const [sourceById, setSourceById] = useState<Map<string, MaterialDto>>(new Map());
  const [completedMaterialId, setCompletedMaterialId] = useState<string | null>(null);

  function resetWizard() {
    setStep(0);
    setRecipe(null);
    setBatchSize(0);
    setMapping({});
    setWeights({});
    setColorName('');
    setIdempotencyKey('');
    setSourceById(new Map());
    setCompletedMaterialId(null);
  }

  function selectRecipe(r: MixRecipeDto) {
    const nominal = r.components.reduce((s, c) => s + c.ratioOrGrams, 0);
    setRecipe(r);
    setBatchSize(nominal);
    setMapping({});
    setWeights({});
    setColorName('');
    setIdempotencyKey(crypto.randomUUID());
    setSourceById(new Map());
    setCompletedMaterialId(null);
    setStep(1);
  }

  // Compute draws + total + swatch for Review / Complete. Only meaningful once
  // a recipe is chosen and weights entered.
  const { draws, totalVolume, mixedHex } = useMemo(() => {
    if (!recipe) return { draws: [], totalVolume: 0, mixedHex: null as string | null };
    const built = buildDraws(recipe.components, mapping, sourceById, weights);
    const hex = synthesizeHex(
      built.draws.map((d) => ({ hex: d.sourceHex, weight: d.drawAmount })),
    );
    return { draws: built.draws, totalVolume: built.totalVolume, mixedHex: hex };
  }, [recipe, mapping, sourceById, weights]);

  const sourceIds = useMemo(
    () => (recipe ? recipe.components.map((_, i) => mapping[i] ?? '').filter(Boolean) : []),
    [recipe, mapping],
  );

  const mutation = useMutation({
    mutationFn: async (): Promise<MixBatchResponse> => {
      if (!recipe) throw new Error('No recipe selected.');
      const colorBlock =
        mixedHex != null
          ? {
              colors: [mixedHex],
              colorPattern: 'solid' as const,
              colorName: colorName.trim() || recipe.name,
            }
          : {};
      const body = {
        recipeId: recipe.id,
        totalVolume,
        perComponentDraws: draws.map((d) => ({
          sourceMaterialId: d.sourceMaterialId,
          drawAmount: d.drawAmount,
          provenanceClass: d.provenanceClass,
        })),
        ...colorBlock,
      };
      const res = await fetch('/api/v1/materials/mix-batches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(mixReasonMessage(data.error ?? 'unknown', data.message));
      }
      return (await res.json()) as MixBatchResponse;
    },
    onSuccess: (data) => {
      toast.success('Mix registered.');
      setCompletedMaterialId(data.mixBatchMaterialId);
      // Source bottles were decremented + a new mix_batch material created.
      queryClient.invalidateQueries({ queryKey: ['materials'] });
      setStep(5);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-2 flex items-baseline gap-3.5">
        <Link
          href="/materials"
          className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint hover:text-fg-muted"
        >
          Workshop
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">›</span>
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">
          Guided mix
        </span>
        <span className="flex-1 border-b border-hairline" />
      </div>

      {step === 0 ? (
        <>
          <h1 className="m-0 mb-1.5 font-serif text-[44px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
            Mix a batch.
          </h1>
          <p className="mb-[22px] font-serif text-[16px] italic text-fg-muted">
            Pick a recipe, map your bottles, weigh by hand. We&apos;ll draw the sources and file
            the result.
          </p>
          <MixRecipePicker onSelect={selectRecipe} />
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <MixStepper step={step} />

          {recipe && step === 1 && (
            <MixRecipeCard
              recipe={recipe}
              batchSize={batchSize}
              onBatchSize={setBatchSize}
              onNext={() => setStep(2)}
            />
          )}

          {recipe && step === 2 && (
            <MixSourceMap
              recipe={recipe}
              batchSize={batchSize}
              mapping={mapping}
              onMap={(componentIndex, material) => {
                setMapping((m) => ({ ...m, [componentIndex]: material?.id ?? '' }));
                if (material) {
                  setSourceById((prev) => {
                    const next = new Map(prev);
                    next.set(material.id, material);
                    return next;
                  });
                }
              }}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}

          {recipe && step === 3 && (
            <MixManualEntry
              recipe={recipe}
              batchSize={batchSize}
              mapping={mapping}
              sourceById={sourceById}
              weights={weights}
              onWeight={(componentIndex, value) =>
                setWeights((w) => ({ ...w, [componentIndex]: value }))
              }
              onBack={() => setStep(2)}
              onNext={() => setStep(4)}
            />
          )}

          {recipe && step === 4 && (
            <MixReview
              recipe={recipe}
              batchSize={batchSize}
              draws={draws}
              totalVolume={totalVolume}
              mixedHex={mixedHex}
              colorName={colorName}
              onColorName={setColorName}
              onBack={() => setStep(3)}
              onRegister={() => mutation.mutate()}
              isPending={mutation.isPending}
            />
          )}

          {recipe && step === 5 && completedMaterialId && (
            <MixComplete
              recipe={recipe}
              draws={draws}
              totalVolume={totalVolume}
              mixBatchMaterialId={completedMaterialId}
              sourceIds={sourceIds}
              onReset={resetWizard}
            />
          )}
        </div>
      )}
    </div>
  );
}
