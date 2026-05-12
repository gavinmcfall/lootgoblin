// WatchKindChip — small mono chip mapping subscription kind → display label.
// Canvas variant: WatchKindChip (page-subscriptions.jsx line 17-19).
// Maps the 5 backend kinds to short display labels (canvas knew 3; backend has 5).

export type WatchKind =
  | 'creator'
  | 'tag'
  | 'saved_search'
  | 'url_watch'
  | 'folder_watch';

const KIND_LABEL: Record<WatchKind, string> = {
  creator: 'creator',
  tag: 'tag',
  saved_search: 'search',
  url_watch: 'url',
  folder_watch: 'folder',
};

export function WatchKindChip({ kind }: { kind: string }) {
  const label = KIND_LABEL[kind as WatchKind] ?? kind;
  return (
    <span className="inline-block rounded-[3px] border border-hairline px-[7px] py-[2px] font-mono text-[9px] uppercase tracking-[0.6px] text-fg-faint">
      {label}
    </span>
  );
}
