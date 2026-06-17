// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// /reports — redirect to /reports/consumption until other report types land.

import { redirect } from 'next/navigation';

export default function ReportsIndexPage() {
  redirect('/reports/consumption');
}
