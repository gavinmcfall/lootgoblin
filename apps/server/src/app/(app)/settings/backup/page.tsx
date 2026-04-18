export default function BackupPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-100">Settings — Backup</h2>
      <div className="rounded-lg border border-amber-700 bg-amber-900/20 p-4 text-sm">
        <p className="font-medium text-amber-200">Keep your secret</p>
        <p className="mt-1 text-amber-100/80">
          Your <code className="font-mono">LOOTGOBLIN_SECRET</code> encrypts all stored source credentials. If you lose it, those credentials become unrecoverable.
        </p>
      </div>
      <p className="text-sm text-slate-500">Backup download coming soon. For now, copy <code className="font-mono text-slate-300">/config/lootgoblin.db</code> from the container volume.</p>
    </div>
  );
}
