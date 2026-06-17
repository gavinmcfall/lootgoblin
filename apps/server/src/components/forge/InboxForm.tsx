// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// InboxForm — create + edit form for Forge inbox watch folders.
// Mirrors DestinationForm pattern: useForm + zodResolver + full a11y triple
// (id, htmlFor, aria-describedby, aria-invalid, role=alert, serverError slot).

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const Schema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  path: z.string().min(1, 'Path is required'),
  defaultPrinterId: z.string().optional(),
  active: z.boolean(),
  notes: z.string().max(500).optional(),
});

export type InboxFormValues = z.infer<typeof Schema>;

export function InboxForm({
  onSubmit,
  defaults,
  submitLabel = 'Save',
  serverError,
}: {
  onSubmit: (v: InboxFormValues) => Promise<void>;
  defaults?: Partial<InboxFormValues>;
  submitLabel?: string;
  serverError?: string;
}) {
  const { register, handleSubmit, formState } = useForm<InboxFormValues>({
    resolver: zodResolver(Schema),
    mode: 'onChange',
    defaultValues: {
      name: '',
      path: '',
      defaultPrinterId: '',
      active: true,
      notes: '',
      ...defaults,
    },
  });
  const errors = formState.errors;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
      {/* Name */}
      <div>
        <label htmlFor="field-inbox-name">
          <span className="block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1">
            Name
          </span>
        </label>
        <input
          {...register('name')}
          id="field-inbox-name"
          aria-describedby={errors.name ? 'err-inbox-name' : undefined}
          aria-invalid={errors.name ? true : undefined}
          className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13.5px] text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent"
          placeholder="My slicer output"
        />
        {errors.name && (
          <p id="err-inbox-name" role="alert" className="mt-1 text-[11px] text-danger">
            {errors.name.message}
          </p>
        )}
      </div>

      {/* Path */}
      <div>
        <label htmlFor="field-inbox-path">
          <span className="block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1">
            Watch path
          </span>
        </label>
        <input
          {...register('path')}
          id="field-inbox-path"
          aria-describedby={errors.path ? 'err-inbox-path' : undefined}
          aria-invalid={errors.path ? true : undefined}
          className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13.5px] font-mono text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent"
          placeholder="/home/user/PrusaSlicer/output"
        />
        {errors.path && (
          <p id="err-inbox-path" role="alert" className="mt-1 text-[11px] text-danger">
            {errors.path.message}
          </p>
        )}
      </div>

      {/* Default printer ID (optional) */}
      <div>
        <label htmlFor="field-inbox-printer">
          <span className="block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1">
            Default printer ID{' '}
            <span className="normal-case text-fg-ghost">(optional)</span>
          </span>
        </label>
        <input
          {...register('defaultPrinterId')}
          id="field-inbox-printer"
          aria-describedby={errors.defaultPrinterId ? 'err-inbox-printer' : undefined}
          aria-invalid={errors.defaultPrinterId ? true : undefined}
          className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13.5px] font-mono text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent"
          placeholder="Printer UUID"
        />
        {errors.defaultPrinterId && (
          <p id="err-inbox-printer" role="alert" className="mt-1 text-[11px] text-danger">
            {errors.defaultPrinterId.message}
          </p>
        )}
      </div>

      {/* Active toggle */}
      <div className="flex items-center gap-3">
        <input
          {...register('active')}
          id="field-inbox-active"
          type="checkbox"
          className="h-4 w-4 rounded border-hairline text-accent focus:ring-accent-edge"
        />
        <label htmlFor="field-inbox-active" className="font-sans text-[13px] text-fg">
          Active — watch this folder for new files
        </label>
      </div>

      {/* Notes */}
      <div>
        <label htmlFor="field-inbox-notes">
          <span className="block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1">
            Notes{' '}
            <span className="normal-case text-fg-ghost">(optional)</span>
          </span>
        </label>
        <textarea
          {...register('notes')}
          id="field-inbox-notes"
          aria-describedby={errors.notes ? 'err-inbox-notes' : undefined}
          aria-invalid={errors.notes ? true : undefined}
          rows={3}
          className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13.5px] text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent resize-none"
          placeholder="e.g. PrusaSlicer projects folder for the workshop machine"
        />
        {errors.notes && (
          <p id="err-inbox-notes" role="alert" className="mt-1 text-[11px] text-danger">
            {errors.notes.message}
          </p>
        )}
      </div>

      {/* Server error */}
      {serverError && (
        <p role="alert" className="text-[11.5px] text-danger">
          {serverError}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={!formState.isValid || formState.isSubmitting}
        className="bg-accent text-accent-ink rounded-md px-4 py-2 text-[12.5px] font-semibold shadow-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {formState.isSubmitting ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
