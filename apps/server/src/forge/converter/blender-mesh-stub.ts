/**
 * blender-mesh-stub.ts — V2-005b T_b1
 *
 * Stub for the Blender CLI mesh converter. T_b2 fills this in (stl ↔ 3mf,
 * obj/fbx/glb → stl). T_b1 ships the stub so the framework's dispatch
 * shape is complete and T_b3 (worker integration) can wire up the entire
 * surface area without waiting on T_b2.
 *
 * Returning `not-implemented` (rather than throwing) keeps the
 * ConversionResult type total — callers always branch on `ok`.
 */

import type { ConversionResult } from './types';

export interface ConvertMeshInput {
  inputPath: string;
  inputFormat: string;
  outputFormat: string;
  outputDir: string;
}

const T_B2_MESSAGE = 'Blender mesh conversion ships in V2-005b-T_b2';

export async function convertMesh(
  _input: ConvertMeshInput,
): Promise<ConversionResult> {
  return {
    ok: false,
    reason: 'not-implemented',
    details: T_B2_MESSAGE,
  };
}

/** Mesh formats this stub claims (so dispatch routes here, not 'unsupported-pair'). */
export const MESH_FORMATS: ReadonlySet<string> = new Set([
  'stl',
  '3mf',
  'obj',
  'fbx',
  'glb',
  'gltf',
  'ply',
  'step',
  'stp',
  'amf',
]);

export function isMeshFormat(format: string): boolean {
  return MESH_FORMATS.has(format);
}
