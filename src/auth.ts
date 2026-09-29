import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { resolveAppDeps } from "@/lib/appDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";

/**
 * Auth.js Google OAuth configuration. Credentials are read only at runtime
 * from the server environment and are never bundled into the client.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? process.env.PEAKCUT_AUTH_SECRET,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
    }),
  ],
  pages: { signIn: "/login" },
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google" || !user.email || !user.id) return false;
      const deps = resolveAppDeps();
      new SqliteUserRepository(deps.db).findOrCreateGoogleUser(user.email, user.id);
      return true;
    },
    async jwt({ token, user, account }) {
      if (account?.provider === "google" && user.email && user.id) {
        const deps = resolveAppDeps();
        const localUser = new SqliteUserRepository(deps.db).findOrCreateGoogleUser(user.email, user.id);
        token.peakcutUserId = localUser.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.peakcutUserId === "string") {
        session.user.id = token.peakcutUserId;
      }
      return session;
    },
  },
});
