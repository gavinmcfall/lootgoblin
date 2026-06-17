// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /hoard/adopt/[stashRootId] — the Library Adoption wizard.
//
// Visual language ported from planning/design-system/lib/page-adoption.jsx
// (warm-graphite tokens, Playfair serif mastheads, Space Mono labels, left
// stepper rail + main pane + right reading rail) but rendered with Tailwind
// token classes inside the existing (app) shell.
//
// The mock's 5 steps collapse to 4 real steps wired to real endpoints:
//   Scan     → POST .../adoption/scan       (synchronous walk)
//   Select   → candidate-level checkboxes   (no per-file classify/override)
//   Template → POST .../adoption/preview     (real counts + example moves)
//   Apply    → POST .../adoption/apply        (synchronous, one-shot)
//
// Degradations (see report): no live counters/tail/phase bars, no per-file
// Sorter, one template take (not the A/B comparator), dry-run = the preview
// response, "Open in Hoard" degrades to /stash (the apply report's collectionId
// is a Collection id, not a hoard-library id — /hoard/{id}/browse keys on the
// latter, so it would 404).

import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { EmptyHint } from '@/components/shell/atoms';
import { AdoptionStepper } from '@/components/adoption/AdoptionStepper';
import { AdoptionScanStep } from '@/components/adoption/AdoptionScanStep';
import { AdoptionSelectStep } from '@/components/adoption/AdoptionSelectStep';
import { AdoptionTemplateStep } from '@/components/adoption/AdoptionTemplateStep';
import { AdoptionApplyStep } from '@/components/adoption/AdoptionApplyStep';
import {
  adoptionErrorMessage,
  type AdoptionMode,
  type ApplyReportDto,
  type CandidateDto,
  type PreviewResponseDto,
  type ScanResponseDto,
  type StashRootDto,
  type StashRootsResponse,
  type TemplateOptionDto,
} from '@/components/adoption/types';

interface ErrorBody {
  error?: string;
  reason?: string;
}

async function parseError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  return adoptionErrorMessage(body.error, body.reason);
}

/** Defensive read of a `useMutation` error (typed `unknown`). */
function mutationErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export default function AdoptWizardPage({
  params,
}: {
  params: Promise<{ stashRootId: string }>;
}) {
  const { stashRootId } = use(params);

  // ── Wizard state ───────────────────────────────────────────────────────────
  const [step, setStep] = useState(0);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateDto[]>([]);
  const [derivedTemplates, setDerivedTemplates] = useState<{
    templates: string[];
    patternDetected: boolean;
  }>({ templates: [], patternDetected: false });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewOptions, setPreviewOptions] = useState<TemplateOptionDto[]>([]);
  const [chosenTemplate, setChosenTemplate] = useState<string | null>(null);
  const [collectionName, setCollectionName] = useState('');
  const [mode, setMode] = useState<AdoptionMode>('copy-then-cleanup');
  const [report, setReport] = useState<ApplyReportDto | null>(null);

  // ── Stash root lookup (no single-root GET, so list + find) ──────────────────
  const rootQuery = useQuery({
    queryKey: ['stash-roots'],
    queryFn: async (): Promise<StashRootsResponse> => {
      const res = await fetch('/api/v1/stash-roots?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
  const root: StashRootDto | undefined = rootQuery.data?.items.find((r) => r.id === stashRootId);

  // Default the collection name once the root resolves (only if untouched).
  const nameSeeded = useRef(false);
  useEffect(() => {
    if (root && !nameSeeded.current) {
      setCollectionName(`Adopted — ${root.name}`);
      nameSeeded.current = true;
    }
  }, [root]);

  // ── Scan mutation ───────────────────────────────────────────────────────────
  const scanMutation = useMutation({
    mutationFn: async (): Promise<ScanResponseDto> => {
      const res = await fetch(`/api/v1/stash-roots/${stashRootId}/adoption/scan`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await parseError(res));
      return res.json();
    },
    onSuccess: (data) => {
      setProposalId(data.proposalId);
      setCandidates(data.candidates);
      setDerivedTemplates(data.derivedTemplates);
      setSelectedIds(new Set(data.candidates.map((c) => c.id)));
      setStep(1);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Preview mutation ────────────────────────────────────────────────────────
  // Latest-wins guard: each preview request is stamped with a monotonic id.
  // useMutation does not serialize/cancel, so rapid selection toggles can fire
  // overlapping requests whose responses arrive out of order. We ignore any
  // payload whose stamp is not the most recent one issued, so the displayed
  // counts always match the selection that triggered the latest request.
  const previewRequestSeq = useRef(0);
  const latestPreviewRequest = useRef(0);
  const previewMutation = useMutation({
    mutationFn: async (): Promise<{ requestId: number; payload: PreviewResponseDto }> => {
      if (!proposalId) throw new Error('No proposal. Rescan to continue.');
      const requestId = ++previewRequestSeq.current;
      latestPreviewRequest.current = requestId;
      const res = await fetch(`/api/v1/stash-roots/${stashRootId}/adoption/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId,
          templates: derivedTemplates.templates,
          selectedCandidateIds: Array.from(selectedIds),
        }),
      });
      if (!res.ok) throw new Error(await parseError(res));
      const payload = (await res.json()) as PreviewResponseDto;
      return { requestId, payload };
    },
    onSuccess: ({ requestId, payload }) => {
      // Drop stale responses — only the most recently issued request wins.
      if (requestId !== latestPreviewRequest.current) return;
      setPreviewOptions(payload.options);
      // Reconcile the chosen template if the new option set no longer has it.
      setChosenTemplate((prev) =>
        prev && payload.options.some((o) => o.template === prev) ? prev : null,
      );
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Apply mutation ──────────────────────────────────────────────────────────
  const applyMutation = useMutation({
    mutationFn: async (): Promise<ApplyReportDto> => {
      if (!proposalId) throw new Error('No proposal. Rescan to continue.');
      if (!chosenTemplate) throw new Error('No template chosen.');
      const res = await fetch(`/api/v1/stash-roots/${stashRootId}/adoption/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId,
          template: chosenTemplate,
          selectedCandidateIds: Array.from(selectedIds),
          mode,
          collectionName: collectionName.trim(),
        }),
      });
      if (!res.ok) throw new Error(await parseError(res));
      return res.json();
    },
    onSuccess: (data) => {
      setReport(data);
      if (data.errors.length > 0) {
        toast.warning(`Adopted ${data.adoptedCount}; ${data.errors.length} stuck.`);
      } else {
        toast.success(`Adopted ${data.adoptedCount} item${data.adoptedCount === 1 ? '' : 's'}.`);
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Enter the Template step → run the preview. Re-run when the selection
  // changes while on that step (so collision counts stay honest).
  // The mutate fn is held in a ref so the effect can depend only on the real
  // trigger values (step / selection / templates) without re-running when the
  // mutation object identity changes between renders.
  const selectionKey = useMemo(() => Array.from(selectedIds).sort().join(','), [selectedIds]);
  const runPreviewRef = useRef(() => previewMutation.mutate());
  runPreviewRef.current = () => previewMutation.mutate();
  useEffect(() => {
    if (step === 2 && proposalId && derivedTemplates.templates.length > 0 && selectionKey !== '') {
      runPreviewRef.current();
    }
  }, [step, proposalId, selectionKey, derivedTemplates.templates.length]);

  // Cross-step focus handoff (a11y) — matches the Mix wizard pattern.
  const stepRegionRef = useRef<HTMLDivElement>(null);
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    stepRegionRef.current?.focus();
  }, [step]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll(nextOn: boolean) {
    setSelectedIds(nextOn ? new Set(candidates.map((c) => c.id)) : new Set());
  }

  const chosenOption = chosenTemplate
    ? (previewOptions.find((o) => o.template === chosenTemplate) ?? null)
    : null;

  // ── Root error / loading gates ──────────────────────────────────────────────
  if (rootQuery.isError) {
    return (
      <div className="space-y-4">
        <EmptyHint>Failed to load this stash root. Try refreshing the page.</EmptyHint>
        <Link
          href="/hoard/adopt"
          className="font-mono text-[11px] uppercase tracking-[1px] text-accent hover:underline"
        >
          ← Back to adopt
        </Link>
      </div>
    );
  }
  if (rootQuery.isLoading) return <EmptyHint>Loading…</EmptyHint>;
  if (!root) {
    return (
      <div className="space-y-4">
        <EmptyHint>
          That stash root could not be found. It may have been removed, or you may not have access.
        </EmptyHint>
        <Link
          href="/hoard/adopt"
          className="font-mono text-[11px] uppercase tracking-[1px] text-accent hover:underline"
        >
          ← Back to adopt
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-7">
      <AdoptionStepper current={step} rootName={root.name} rootPath={root.path} />

      <div ref={stepRegionRef} tabIndex={-1} className="flex min-w-0 flex-1 outline-none">
        {step === 0 && (
          <AdoptionScanStep
            rootName={root.name}
            onScan={() => scanMutation.mutate()}
            isScanning={scanMutation.isPending}
            error={scanMutation.isError ? mutationErrorMessage(scanMutation.error) : null}
          />
        )}

        {step === 1 && (
          <AdoptionSelectStep
            candidates={candidates}
            selectedIds={selectedIds}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <AdoptionTemplateStep
            options={previewOptions}
            patternDetected={derivedTemplates.patternDetected}
            isLoading={previewMutation.isPending}
            error={previewMutation.isError ? mutationErrorMessage(previewMutation.error) : null}
            chosenTemplate={chosenTemplate}
            onChoose={setChosenTemplate}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}

        {step === 3 && (
          <AdoptionApplyStep
            chosenOption={chosenOption}
            selectedCount={selectedIds.size}
            collectionName={collectionName}
            onCollectionName={setCollectionName}
            mode={mode}
            onMode={setMode}
            onApply={() => applyMutation.mutate()}
            isApplying={applyMutation.isPending}
            error={applyMutation.isError ? mutationErrorMessage(applyMutation.error) : null}
            report={report}
            onBack={() => setStep(2)}
          />
        )}
      </div>
    </div>
  );
}
