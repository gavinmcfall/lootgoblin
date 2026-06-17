// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// /forge — redirect to /forge/printers until other Forge surfaces land.
import { redirect } from 'next/navigation';

export default function ForgePage() {
  redirect('/forge/printers');
}
