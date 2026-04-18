import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';
import { credentialsProvider } from './providers-credentials';
import { oidcProvider } from './providers-oidc';
import { env } from '../env';
import authConfig from '../auth.config';

const providers: NextAuthConfig['providers'] = [];
if (env.AUTH_METHODS.includes('forms')) providers.push(credentialsProvider);
const oidc = oidcProvider();
if (oidc) providers.push(oidc as never);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers,
  secret: env.AUTH_SECRET ?? env.LOOTGOBLIN_SECRET,
});
