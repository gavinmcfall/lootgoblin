import { env } from '../env';

export function oidcProvider() {
  if (!env.AUTH_METHODS.includes('oidc')) return null;
  return {
    id: 'oidc',
    name: 'OIDC',
    type: 'oidc' as const,
    issuer: env.OIDC_ISSUER_URL!,
    clientId: env.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!,
    authorization: { params: { scope: env.OIDC_SCOPES } },
    profile(profile: Record<string, unknown>) {
      const groups = Array.isArray(profile.groups) ? (profile.groups as string[]) : [];
      const isAdmin = env.OIDC_ADMIN_GROUP
        ? groups.includes(env.OIDC_ADMIN_GROUP)
        : true;
      return {
        id: String(profile.sub ?? profile.email),
        name: String(profile.preferred_username ?? profile.name ?? ''),
        email: String(profile.email ?? ''),
        role: isAdmin ? 'admin' : 'viewer',
      };
    },
  };
}
