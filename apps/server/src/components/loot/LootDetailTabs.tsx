'use client';
// LootDetailTabs — client-state tab strip for the Loot detail page.
// Uses useState (pure UI state, not URL-coupled) per canvas-port #9 spec.
// Same visual pattern as ForgeTabs / SettingsTabs but tab switching is local.

export type LootTab = 'files' | 'grimoire' | 'consumption' | 'history';

const TABS: { key: LootTab; label: string }[] = [
  { key: 'files',       label: 'Files' },
  { key: 'grimoire',    label: 'Grimoire' },
  { key: 'consumption', label: 'Consumption' },
  { key: 'history',     label: 'History' },
];

interface LootDetailTabsProps {
  active: LootTab;
  onTab: (tab: LootTab) => void;
}

export function LootDetailTabs({ active, onTab }: LootDetailTabsProps) {
  return (
    <nav className="-mt-2 mb-5 flex gap-1 border-b border-hairline">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          aria-current={active === t.key ? 'page' : undefined}
          onClick={() => onTab(t.key)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            active === t.key
              ? 'border-accent text-accent'
              : 'border-transparent text-fg-muted hover:text-fg'
          }`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
