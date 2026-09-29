"use client";

/**
 * Shown when an unauthenticated visitor tries to download the final,
 * full-quality (unwatermarked) export. The free preview (see
 * /api/preview-segment) never triggers this — only the final download
 * does. This is a UX nicety only: the real enforcement is server-side, on
 * /api/export-segment itself, which independently requires a session.
 */
export function AccountGate({
  callbackUrl,
  onClose,
}: {
  callbackUrl: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-gate-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-6 text-center shadow-2xl">
        <h2 id="account-gate-title" className="text-lg font-semibold text-zinc-100">
          Un compte est nécessaire pour télécharger
        </h2>
        <p className="mt-3 text-sm text-zinc-400">
          L&apos;aperçu avec filigrane est gratuit et ne demande aucun compte. Le téléchargement
          final, en pleine qualité et sans filigrane, nécessite un compte PeakCut (connexion
          Google).
        </p>
        <a
          href={`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`}
          className="mt-6 block rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300"
        >
          Se connecter avec Google
        </a>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 text-xs text-zinc-500 transition hover:text-zinc-300"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
