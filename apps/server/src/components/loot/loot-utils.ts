// Shared utility helpers for Loot detail UI.
// Keep this file scoped to /components/loot — if a helper graduates to
// cross-pillar use, move it to apps/server/src/lib/.

/**
 * Format a byte count into a compact human-readable string.
 * < 1 KB returns bytes; < 1 MB returns KB with 1dp; otherwise MB with 1dp.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
