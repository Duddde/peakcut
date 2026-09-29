"use client";

import { useState } from "react";

type ValidationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; videoId: string; normalizedUrl: string }
  | { status: "error"; error: string };

export function YoutubeUrlForm() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<ValidationState>({ status: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/validate-youtube-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setState({ status: "success", videoId: json.videoId, normalizedUrl: json.normalizedUrl });
      } else {
        setState({ status: "error", error: json.error ?? "URL invalide." });
      }
    } catch {
      setState({ status: "error", error: "Impossible de contacter le serveur de validation." });
    }
  }

  return (
    <div className="w-full max-w-xl">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row" noValidate>
        <label htmlFor="youtube-url" className="sr-only">
          Lien YouTube public
        </label>
        <input
          id="youtube-url"
          type="url"
          required
          inputMode="url"
          autoComplete="off"
          placeholder="https://www.youtube.com/watch?v=..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").trim();
            if (pasted) {
              e.preventDefault();
              setUrl(pasted);
              setState({ status: "idle" });
            }
          }}
          aria-invalid={state.status === "error"}
          aria-describedby="youtube-url-help youtube-url-result"
          className="w-full flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none ring-amber-400/50 transition focus:border-amber-400/60 focus:ring-2"
        />
        <button
          type="submit"
          disabled={state.status === "loading" || url.trim().length === 0}
          className="shrink-0 rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.status === "loading" ? "Vérification…" : "Valider le lien"}
        </button>
      </form>

      <p id="youtube-url-help" className="mt-2 text-xs text-zinc-500">
        Validation structurelle uniquement : aucune vidéo n&apos;est téléchargée et rien n&apos;est publié.
      </p>

      <div id="youtube-url-result" role="status" aria-live="polite" className="mt-3">
        {state.status === "success" && (
          <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">
            <p>
              Lien validé (id vidéo <code className="font-mono">{state.videoId}</code>).
            </p>
            <p className="mt-1 text-xs text-emerald-200/80">
              PeakCut ne télécharge pas automatiquement une vidéo YouTube tierce. Pour tester l&apos;éditeur,
              explorez la démo locale ci-dessous ou importez un média dont vous avez les droits.
            </p>
            <button
              type="button"
              onClick={() => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="mt-3 rounded-lg border border-emerald-300/40 px-3 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-300/10"
            >
              Explorer la démo dans le studio ↓
            </button>
          </div>
        )}
        {state.status === "error" && (
          <p className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-2 text-sm text-rose-300">
            {state.error}
          </p>
        )}
      </div>
    </div>
  );
}
