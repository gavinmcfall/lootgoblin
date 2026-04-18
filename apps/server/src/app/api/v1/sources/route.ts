import { NextResponse } from 'next/server';
import { listAdapters } from '@/adapters';
export async function GET() {
  return NextResponse.json({ sources: listAdapters().map((a) => a.capabilities) });
}
