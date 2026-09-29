import { isDevLoginEnabled } from "@/lib/auth/devLogin";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { DevLoginForm } from "@/components/auth/DevLoginForm";

const DEFAULT_CALLBACK_URL = "/projects";

/**
 * Only a same-origin, path-relative destination is ever accepted. A
 * `callbackUrl` arrives from the query string, so an absolute or
 * protocol-relative one would turn this page into an open redirect.
 */
function safeCallbackUrl(raw: string | string[] | undefined): string {
  if (typeof raw !== "string") return DEFAULT_CALLBACK_URL;
  if (!raw.startsWith("/") || raw.startsWith("//")) return DEFAULT_CALLBACK_URL;
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const callbackUrl = safeCallbackUrl((await searchParams).callbackUrl);
  const devLogin = isDevLoginEnabled();

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/70 p-8 text-center shadow-2xl">
        <p className="text-sm font-semibold tracking-tight text-amber-300">PeakCut</p>
        <h1 className="mt-3 text-2xl font-bold">Accéder à votre studio</h1>
        <p className="mt-3 text-sm text-zinc-400">
          Connectez-vous avec Google pour retrouver vos projets et vos exports.
        </p>

        <div className="mt-8">
          <GoogleSignInButton callbackUrl={callbackUrl} />
        </div>

        {devLogin && (
          <div className="mt-8 border-t border-white/10 pt-6">
            <p className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-left text-[11px] text-amber-200/90">
              <strong className="font-semibold">Connexion locale (développement).</strong> Affichée
              parce que <code className="font-mono">PEAKCUT_DEV_LOGIN=1</code> et que cette
              instance n&apos;est pas en production. Compte réel, mot de passe réellement vérifié —
              ce n&apos;est pas un contournement de l&apos;authentification.
            </p>
            <DevLoginForm callbackUrl={callbackUrl} />
          </div>
        )}

        <p className="mt-6 text-xs text-zinc-500">
          Aucune publication n&apos;est déclenchée automatiquement.
        </p>
      </section>
    </main>
  );
}
