import { subscribe } from '@/lib/sse';

export async function GET(req: Request) {
  if (false) // TODO: auth pending V2-001-T2 return new Response('unauthorized', { status: 401 });
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (msg: string) => {
        try { controller.enqueue(enc.encode(msg)); } catch { /* client disconnected */ }
      };
      send(`event: hello\ndata: {}\n\n`);
      const unsub = subscribe(send);
      const heartbeat = setInterval(() => send(`:heartbeat\n\n`), 20_000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unsub();
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener('abort', cleanup);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  });
}

export const dynamic = 'force-dynamic';
