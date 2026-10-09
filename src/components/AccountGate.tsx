"use client";

import { useEffect, useId, useRef } from "react";
import { safeCallbackUrl } from "@/lib/auth/safeCallbackUrl";

/**
 * Shown when an unauthenticated visitor tries to do something that needs an
 * account: downloading the final, full-quality (unwatermarked) export, or
 * any customisation / processing action on the public demonstration. Simply
 * looking at the demonstration never triggers this.
 *
 * This is a UX nicety only: the real enforcement is server-side, on
 * /api/export-segment and /api/download-youtube, which independently
 * require a session.
 *
 * Keyboard behaviour follows the modal dialog pattern: focus moves to the
 * sign-in link on open, Tab stays inside the dialog, Escape closes it, and
 * focus returns to whatever opened it.
 */
export function AccountGate({
  callbackUrl,
  onClose,
  title = "Un compte est nécessaire pour continuer",
  body = "La démonstration reste consultable gratuitement. Connectez-vous pour personnaliser, importer un média, lancer les traitements et télécharger un export final.",
}: {
  /** Relative, same-origin path to come back to after sign-in; anything else falls back to "/". */
  callbackUrl: string;
  onClose: () => void;
  /** Overrides the dialog heading; keep it starting with "Un compte est nécessaire" so the accessible name stays predictable. */
  title?: string;
  body?: string;
}) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLAnchorElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  const loginHref = `/login?callbackUrl=${encodeURIComponent(safeCallbackUrl(callbackUrl, "/"))}`;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-6 text-center shadow-2xl">
        <h2 id={titleId} className="text-lg font-semibold text-zinc-100">
          {title}
        </h2>
        <p id={bodyId} className="mt-3 text-sm text-zinc-400">
          {body}
        </p>
        <a
          ref={primaryRef}
          href={loginHref}
          className="mt-6 block rounded-xl bg-amber-400 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
        >
          Se connecter ou créer un compte
        </a>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 rounded text-xs text-zinc-400 transition hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
