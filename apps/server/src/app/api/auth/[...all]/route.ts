// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * BetterAuth Next.js App Router catch-all handler — V2-001-T2 (skeleton)
 *
 * Delegates all /api/auth/* requests to the BetterAuth handler.
 * T4 fills in session enrichment, OIDC callback wiring, and
 * email-password flow specifics once middleware + route guards are in place.
 */

import { auth } from '@/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth);
