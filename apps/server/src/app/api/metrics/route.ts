import { registry } from '@/metrics';

export async function GET() {
  const body = await registry.metrics();
  return new Response(body, { headers: { 'content-type': registry.contentType } });
}
