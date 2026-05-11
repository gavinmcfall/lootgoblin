'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { NamingTemplatePreview } from './NamingTemplatePreview';

const Schema = z.object({
  name: z.string().min(1, 'Name is required'),
  path: z.string().min(1, 'Path is required'),
  namingTemplate: z.string().min(1, 'Template is required'),
  packager: z.literal('manyfold-v0'),
  credentialId: z.string().optional(),
});

export type DestinationFormValues = z.infer<typeof Schema>;

export function DestinationForm({
  onSubmit,
  defaults,
  submitLabel = 'Save',
}: {
  onSubmit: (v: DestinationFormValues) => Promise<void>;
  defaults?: Partial<DestinationFormValues>;
  submitLabel?: string;
}) {
  const { register, handleSubmit, watch, formState } = useForm<DestinationFormValues>({
    resolver: zodResolver(Schema),
    mode: 'onChange',
    defaultValues: {
      name: '',
      path: '/library/minis',
      namingTemplate: '{designer}/{title}',
      packager: 'manyfold-v0',
      ...defaults,
    },
  });
  const template = watch('namingTemplate') || '';
  const errors = formState.errors;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="max-w-xl space-y-4">
      <label className="block">
        <span className="block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1">Name</span>
        <input {...register('name')} className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13.5px] text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent" />
        {errors.name && <p className="mt-1 text-[11px] text-danger">{errors.name.message}</p>}
      </label>
      <label className="block">
        <span className="block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1">Filesystem path</span>
        <input {...register('path')} className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13.5px] font-mono text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent" />
        {errors.path && <p className="mt-1 text-[11px] text-danger">{errors.path.message}</p>}
      </label>
      <label className="block">
        <span className="block font-mono text-[10px] uppercase tracking-[1px] text-fg-faint mb-1">Naming template</span>
        <input {...register('namingTemplate')} className="mt-1 w-full rounded-md border border-hairline bg-surface-2 px-3 py-1.5 text-[13.5px] font-mono text-fg placeholder:text-fg-ghost focus:outline-none focus:ring-2 focus:ring-accent-edge focus:border-accent" />
        {errors.namingTemplate && <p className="mt-1 text-[11px] text-danger">{errors.namingTemplate.message}</p>}
      </label>
      <NamingTemplatePreview template={template} />
      <input type="hidden" {...register('packager')} value="manyfold-v0" />
      <button
        type="submit"
        disabled={!formState.isValid || formState.isSubmitting}
        className="bg-accent text-accent-ink rounded-md px-4 py-2 text-[12.5px] font-semibold shadow-sm hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitLabel}
      </button>
    </form>
  );
}
