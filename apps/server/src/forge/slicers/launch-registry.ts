/**
 * V2-005e-T_e4: Slicer launch URI registry.
 *
 * Maps slicer kinds to URI deep-link templates so future UI buttons can
 * navigate to a launch URI and open the operator's locally-installed
 * slicer with a file pre-loaded.
 *
 * URL placeholder: {url} — substituted with lootgoblin's HTTP file-serving
 * URL for the requested loot_file. Browsers WILL pass remote URLs to URI
 * handlers; they refuse local FS paths from remote origins. Lootgoblin's
 * file URL sidesteps that limitation.
 *
 * For slicers with no published URI scheme (PrusaSlicer / Cura / etc.)
 * uriScheme is null and uriTemplate is null; the route returns
 * fallback='download' so the future UI button triggers a Content-Disposition
 * download instead of a deep link.
 *
 * Registry is a TS-side constant (NOT a DB table) — operators don't edit
 * URI templates per-environment in v2-005e. If that becomes necessary,
 * V2-005e-CF-D adds a DB-backed override layer.
 *
 * Note: this kind enum is broader than `FORGE_SLICER_KINDS` in
 * `db/schema.forge.ts`. The DB enum is the runtime entities the agent
 * can drive locally; the launch registry covers the broader landscape of
 * slicers the user might have installed locally so the UI can render
 * launch buttons even for slicers lootgoblin does not orchestrate.
 */

export type SlicerKind =
  | 'bambu_studio'
  | 'orcaslicer'
  | 'prusaslicer'
  | 'superslicer'
  | 'chitubox'
  | 'lychee'
  | 'cura'
  | 'photon_workshop'
  | 'halot_box'
  | 'preform'
  | 'composer';

export const SLICER_KINDS: readonly SlicerKind[] = [
  'bambu_studio',
  'orcaslicer',
  'prusaslicer',
  'superslicer',
  'chitubox',
  'lychee',
  'cura',
  'photon_workshop',
  'halot_box',
  'preform',
  'composer',
] as const;

export type SlicerPlatform = 'macos' | 'windows' | 'linux';

export interface SlicerLaunchSpec {
  displayName: string;
  /** null = no published URI handler; UI must fall back to file download. */
  uriScheme: string | null;
  /** null when uriScheme is null. Use {url} as the file-URL placeholder. */
  uriTemplate: string | null;
  supportedImportExtensions: string[];
  typicalOutputExtensions: string[];
  platforms: SlicerPlatform[];
}

export const SLICER_LAUNCH_REGISTRY: Record<SlicerKind, SlicerLaunchSpec> = {
  bambu_studio: {
    displayName: 'Bambu Studio',
    uriScheme: 'bambu-connect',
    uriTemplate: 'bambu-connect://import-file?url={url}',
    supportedImportExtensions: ['.stl', '.3mf', '.step'],
    typicalOutputExtensions: ['.gcode.3mf'],
    platforms: ['macos', 'windows', 'linux'],
  },
  orcaslicer: {
    displayName: 'OrcaSlicer',
    uriScheme: 'orcaslicer',
    uriTemplate: 'orcaslicer://open?url={url}',
    supportedImportExtensions: ['.stl', '.3mf', '.step', '.obj'],
    typicalOutputExtensions: ['.gcode.3mf', '.gcode'],
    platforms: ['macos', 'windows', 'linux'],
  },
  prusaslicer: {
    displayName: 'PrusaSlicer',
    uriScheme: null,
    uriTemplate: null,
    supportedImportExtensions: ['.stl', '.3mf', '.step', '.obj'],
    typicalOutputExtensions: ['.gcode', '.bgcode'],
    platforms: ['macos', 'windows', 'linux'],
  },
  superslicer: {
    displayName: 'SuperSlicer',
    uriScheme: null,
    uriTemplate: null,
    supportedImportExtensions: ['.stl', '.3mf', '.step', '.obj'],
    typicalOutputExtensions: ['.gcode'],
    platforms: ['macos', 'windows', 'linux'],
  },
  chitubox: {
    displayName: 'ChiTuBox',
    uriScheme: 'chitubox',
    uriTemplate: 'chitubox://open?file={url}',
    supportedImportExtensions: ['.stl', '.obj'],
    typicalOutputExtensions: ['.ctb', '.cbddlp'],
    platforms: ['macos', 'windows', 'linux'],
  },
  lychee: {
    displayName: 'Lychee Slicer',
    uriScheme: 'lychee',
    uriTemplate: 'lychee://open?file={url}',
    supportedImportExtensions: ['.stl', '.obj'],
    typicalOutputExtensions: ['.ctb', '.cbddlp', '.zip'],
    platforms: ['macos', 'windows', 'linux'],
  },
  cura: {
    displayName: 'Ultimaker Cura',
    uriScheme: null,
    uriTemplate: null,
    supportedImportExtensions: ['.stl', '.3mf', '.obj'],
    typicalOutputExtensions: ['.gcode'],
    platforms: ['macos', 'windows', 'linux'],
  },
  photon_workshop: {
    displayName: 'Photon Workshop',
    uriScheme: null,
    uriTemplate: null,
    supportedImportExtensions: ['.stl'],
    typicalOutputExtensions: ['.pwma', '.pwmx', '.photons'],
    platforms: ['windows'],
  },
  halot_box: {
    displayName: 'Halot Box',
    uriScheme: null,
    uriTemplate: null,
    supportedImportExtensions: ['.stl'],
    typicalOutputExtensions: ['.cxdlp'],
    platforms: ['windows'],
  },
  preform: {
    displayName: 'PreForm',
    uriScheme: null,
    uriTemplate: null,
    supportedImportExtensions: ['.stl', '.obj'],
    typicalOutputExtensions: ['.form'],
    platforms: ['macos', 'windows'],
  },
  composer: {
    displayName: 'Asiga Composer',
    uriScheme: null,
    uriTemplate: null,
    supportedImportExtensions: ['.stl'],
    typicalOutputExtensions: ['.cws'],
    platforms: ['windows'],
  },
};

export function isSlicerKind(s: string): s is SlicerKind {
  return Object.prototype.hasOwnProperty.call(SLICER_LAUNCH_REGISTRY, s);
}

export interface RenderedLaunchUri {
  uri: string;
  fallback: 'download' | null;
}

/**
 * Render a launch URI for the given slicer + file URL. Returns
 * `{uri: '', fallback: 'download'}` for slicers with no registered URI
 * scheme — the UI is expected to trigger a download in that case.
 *
 * The lootFileUrl is passed through `encodeURI` so existing percent-encoded
 * sequences are preserved while reserved characters in path segments are
 * left intact (consistent with passing the URL straight to a browser).
 */
export function renderLaunchUri(
  slicerKind: SlicerKind,
  lootFileUrl: string,
): RenderedLaunchUri {
  const spec = SLICER_LAUNCH_REGISTRY[slicerKind];
  if (!spec.uriTemplate) {
    return { uri: '', fallback: 'download' };
  }
  return {
    uri: spec.uriTemplate.replace('{url}', encodeURI(lootFileUrl)),
    fallback: null,
  };
}
