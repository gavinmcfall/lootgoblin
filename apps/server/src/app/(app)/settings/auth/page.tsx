export default function AuthSettingsPage() {
  const methods = (process.env.AUTH_METHODS ?? 'forms').split(',').map((m) => m.trim());
  const oidcConfigured = !!process.env.OIDC_ISSUER_URL;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-slate-100">Settings — Auth</h2>
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 text-sm">
        <p>
          <span className="text-slate-400">Active methods: </span>
          <span className="font-mono text-slate-100">{methods.join(', ')}</span>
        </p>
        {oidcConfigured && (
          <p className="mt-2">
            <span className="text-slate-400">OIDC issuer: </span>
            <span className="font-mono text-slate-300">{process.env.OIDC_ISSUER_URL}</span>
          </p>
        )}
        <p className="mt-4 text-xs text-slate-500">
          Auth method is configured via the <code>AUTH_METHODS</code> env var. Restart the server after changing.
        </p>
      </div>
    </div>
  );
}
