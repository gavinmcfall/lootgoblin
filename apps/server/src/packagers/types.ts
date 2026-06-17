// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FetchedItem } from '../adapters/types';

export interface Packager {
  id: string;
  package(stagingDir: string, item: FetchedItem): Promise<void>;
}
