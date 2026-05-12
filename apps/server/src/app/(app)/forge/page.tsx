// /forge — redirect to /forge/printers until other Forge surfaces land.
import { redirect } from 'next/navigation';

export default function ForgePage() {
  redirect('/forge/printers');
}
