"use client";

import { signIn } from "next-auth/react";

/**
 * `callbackUrl` is passed in from the server page, which reads it from the
 * query string. It used to be hardcoded to "/projects" here, which silently
 * discarded the `?callbackUrl=` that AccountGate takes care to build — so a
 * visitor gated mid-action came back to the wrong page and lost what they
 * were doing.
 */
export function GoogleSignInButton({ callbackUrl }: { callbackUrl: string }) {
  return (
    <button
      type="button"
      onClick={() => signIn("google", { callbackUrl })}
      className="w-full rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300"
    >
      Continuer avec Google
    </button>
  );
}
