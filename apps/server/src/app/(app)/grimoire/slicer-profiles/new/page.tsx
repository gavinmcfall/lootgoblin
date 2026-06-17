// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

'use client';
// /grimoire/slicer-profiles/new — create a slicer profile.
// Canvas reference: GrimoireDetail form fields (page-grimoire.jsx line 188–277).

import Link from 'next/link';
import { SlicerProfileForm } from '@/components/grimoire/SlicerProfileForm';

export default function SlicerProfileNewPage() {
  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-2 flex items-baseline gap-3.5">
        <Link
          href="/grimoire"
          className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint hover:text-fg-muted"
        >
          Grimoire
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">›</span>
        <Link
          href="/grimoire"
          className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint hover:text-fg-muted"
        >
          Slicer profiles
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">›</span>
        <span className="font-mono text-[10px] uppercase tracking-[1.8px] text-fg-faint">New</span>
        <span className="flex-1 border-b border-hairline" />
      </div>

      {/* Page header */}
      <h1 className="m-0 mb-1.5 font-serif text-[44px] font-normal leading-[1.02] tracking-[-1.1px] text-fg">
        New slicer profile.
      </h1>
      <p className="mb-[22px] font-serif text-[16px] italic text-fg-muted">
        Name it, pick the slicer + printer + material, and paste your settings JSON.
      </p>

      <SlicerProfileForm />
    </div>
  );
}
