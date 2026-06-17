// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registry } from '@/metrics';

export async function GET() {
  const body = await registry.metrics();
  return new Response(body, { headers: { 'content-type': registry.contentType } });
}
