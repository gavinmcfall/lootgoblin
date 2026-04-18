import NextAuth from 'next-auth';
import { credentialsProvider } from './providers-credentials';
import { oidcProvider } from './providers-oidc';
import { env } from '../env';

const providers = [];
if (env.AUTH_METHODS.includes('forms')) providers.push(credentialsProvider);
const oidc = oidcProvider();
if (oidc) providers.push(oidc as never);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    jwt({ token, user }) {
      if (user) token.role = (user as { role?: string }).role ?? 'viewer';
      return token;
    },
    session({ session, token }) {
      (session.user as { role?: string }).role = token.role as string;
      return session;
    },
  },
});
