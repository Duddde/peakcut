"use client";

import { useId, useState } from "react";

/**
 * Local email/password sign-in, rendered only when isDevLoginEnabled() says
 * so (see src/lib/auth/devLogin.ts). It posts to the same
 * /api/auth/login and /api/auth/signup routes that already existed — no new
 * authentication path, no shared or hardcoded account, no way to sign in
 * without a real password that scrypt verifies.
 *
 * Its purpose is to make the app testable without Google OAuth credentials,
 * so the download flow can be exercised end to end locally.
 */

type Status = "idle" | "working" | "error";

const MIN_PASSWORD_LENGTH = 8;

export function DevLoginForm({ callbackUrl }: { callbackUrl: string }) {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(endpoint: "login" | "signup") {
    setStatus("working");
    setMessage(endpoint === "signup" ? "Création du compte…" : "Connexion…");

    try {
      const res = await fetch(`/api/auth/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => null);

      if (!res.ok || json?.ok !== true) {
        setStatus("error");
        setMessage(typeof json?.error === "string" ? json.error : "Échec de la connexion.");
        return;
      }

      // The session cookie is set by the route itself; a full navigation is
      // what makes the server components on the destination see it.
      window.location.href = callbackUrl;
    } catch {
      setStatus("error");
      setMessage("Impossible de contacter le serveur.");
    }
  }

  const canSubmit =
    email.trim().length > 0 && password.length >= MIN_PASSWORD_LENGTH && status !== "working";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) submit("login");
      }}
      className="space-y-3 text-left"
      noValidate
    >
      <div>
        <label htmlFor={emailId} className="block text-xs font-medium text-zinc-400">
          Email
        </label>
        <input
          id={emailId}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-400/60"
        />
      </div>

      <div>
        <label htmlFor={passwordId} className="block text-xs font-medium text-zinc-400">
          Mot de passe
        </label>
        <input
          id={passwordId}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-400/60"
        />
        <p className="mt-1 text-[11px] text-zinc-600">
          {MIN_PASSWORD_LENGTH} caractères minimum pour créer un compte.
        </p>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-zinc-100 transition hover:border-amber-400/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Se connecter
        </button>
        <button
          type="button"
          onClick={() => canSubmit && submit("signup")}
          disabled={!canSubmit}
          className="flex-1 rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300 transition hover:border-amber-400/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Créer le compte
        </button>
      </div>

      <p
        role="status"
        aria-live="polite"
        aria-label="Statut de la connexion locale"
        className={`text-xs ${status === "error" ? "text-rose-300" : "text-zinc-500"}`}
      >
        {message}
      </p>
    </form>
  );
}
