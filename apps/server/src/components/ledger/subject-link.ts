/**
 * For a given subjectType + subjectId, return a domain page URL we can link
 * to, or null when we don't have a confident match. Used by both the table
 * row (Subject column) and the detail page (relatedResources list, subject KV).
 *
 * Conservative: when uncertain, return null so the caller renders plain text.
 */
export function subjectHref(subjectType: string, subjectId: string): string | null {
  switch (subjectType) {
    case 'material':
      return `/materials/${subjectId}`;
    case 'loot':
      return `/loot/${subjectId}`;
    case 'collection':
      return `/hoard/${subjectId}/browse`;
    case 'quarantine_item':
      return `/system/quarantine`;
    case 'watchlist_subscription':
      return `/scouts/watchlist`;
    case 'printer':
      return `/forge/printers`;
    case 'slicer_profile':
    case 'print_setting':
      return `/grimoire`;
    default:
      return null;
  }
}
