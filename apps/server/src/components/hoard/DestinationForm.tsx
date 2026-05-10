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
        <span className="text-sm text-slate-300">Name</span>
        <input {...register('name')} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 text-slate-100" />
        {errors.name && <p className="mt-1 text-xs text-red-400">{errors.name.message}</p>}
      </label>
      <label className="block">
        <span className="text-sm text-slate-300">Filesystem path</span>
        <input {...register('path')} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-slate-100" />
        {errors.path && <p className="mt-1 text-xs text-red-400">{errors.path.message}</p>}
      </label>
      <label className="block">
        <span className="text-sm text-slate-300">Naming template</span>
        <input {...register('namingTemplate')} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 p-2 font-mono text-slate-100" />
        {errors.namingTemplate && <p className="mt-1 text-xs text-red-400">{errors.namingTemplate.message}</p>}
      </label>
      <NamingTemplatePreview template={template} />
      <input type="hidden" {...register('packager')} value="manyfold-v0" />
      <button
        type="submit"
        disabled={!formState.isValid || formState.isSubmitting}
        className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitLabel}
      </button>
    </form>
  );
}
