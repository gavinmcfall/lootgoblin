// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * classifier-providers/index.ts — Barrel export for all built-in classifier providers.
 *
 * Each export is a factory function `createFooProvider(): ClassifierProvider`.
 * Consumers register the providers they need when calling `createClassifier()`.
 *
 * ADR-010: Only rules-based providers are exported here. AI providers are
 * reserved extension points — they implement ClassifierProvider from scratch.
 */

export { createThreeMfProvider } from './three-mf';
export { createDatapackageProvider } from './datapackage';
export { createFilenameProvider } from './filename';
export { createFolderPatternProvider } from './folder-pattern';
export { createExifProvider } from './exif';
export {
  createSlicerOutputProvider,
  detectSlicerOutputFormat,
} from './slicer-output';
