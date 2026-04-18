import { NextResponse } from 'next/server';
import { loadSiteConfigs } from '@/lib/site-configs';

const INTERPRETER_VERSION = 1;

export async function GET(req: Request) {
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // v1: accept any non-empty key. Real validation lands when api_keys table use is wired.
  const configs = await loadSiteConfigs();
  return NextResponse.json({ configs, interpreterVersion: INTERPRETER_VERSION });
}
