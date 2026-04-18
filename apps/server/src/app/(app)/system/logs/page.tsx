export default function LogsPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-100">System — Logs</h2>
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm text-slate-400">
        <p>Structured logs stream to stdout. For now, view them in the server terminal or aggregator (OTEL / docker logs).</p>
        <p className="mt-2 text-xs text-slate-500">
          A live tail UI is planned — requires wiring pino to a file sink and SSE streaming the tail. Tracked as post-v1.
        </p>
      </div>
    </div>
  );
}
