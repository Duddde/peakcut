"use client";

import { signIn } from "next-auth/react";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-100">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900/70 p-8 text-center shadow-2xl">
        <p className="text-sm font-semibold tracking-tight text-amber-300">PeakCut</p>
        <h1 className="mt-3 text-2xl font-bold">Accéder à votre studio</h1>
        <p className="mt-3 text-sm text-zinc-400">
          Connectez-vous avec Google pour retrouver vos projets et vos exports.
        </p>
        <button
          type="button"
          onClick={() => signIn("google", { callbackUrl: "/projects" })}
          className="mt-8 w-full rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300"
        >
          Continuer avec Google
        </button>
        <p className="mt-6 text-xs text-zinc-500">
          Aucune publication n&apos;est déclenchée automatiquement.
        </p>
      </section>
    </main>
  );
}
