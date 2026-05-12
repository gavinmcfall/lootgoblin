// /reports — redirect to /reports/consumption until other report types land.

import { redirect } from 'next/navigation';

export default function ReportsIndexPage() {
  redirect('/reports/consumption');
}
