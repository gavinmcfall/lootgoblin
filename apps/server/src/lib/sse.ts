// v1 SSE emitter — expanded in B-13 with subscribers
type Subscriber = (msg: string) => void;
const subs = new Set<Subscriber>();
export function emit(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of subs) s(payload);
}
export function subscribe(s: Subscriber): () => void {
  subs.add(s);
  return () => subs.delete(s);
}
