import {
  formatTrialDuration,
  formatTrialExpiry,
  formatTrialSize,
  type PublicTrialLimitsSummary,
} from "@/lib/publicTrial/client";

/**
 * States the public trial's limits plainly, wherever a trial visitor acts:
 * what they get, for how long, and what is deliberately not included.
 */
export function PublicTrialNotice({
  limits,
  expiresAt,
}: {
  limits: PublicTrialLimitsSummary;
  /** Omitted before the trial has started. */
  expiresAt?: string;
}) {
  return (
    <section
      aria-label="Limites de l'essai public"
      className="rounded-xl border border-sky-400/30 bg-sky-400/10 px-4 py-3 text-xs text-sky-100"
    >
      <p className="font-semibold">
        Essai public sans compte
        {expiresAt ? ` — expire à ${formatTrialExpiry(expiresAt)}` : ` — ${formatTrialDuration(limits.ttlMinutes)}`}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5">
        <li>
          Projets éphémères, supprimés avec leurs fichiers à l&apos;expiration ({formatTrialDuration(limits.ttlMinutes)}).
        </li>
        <li>
          Vidéo de {limits.maxDurationMinutes} min et {formatTrialSize(limits.maxSizeMb)} maximum,{" "}
          {limits.maxDownloads} téléchargement(s) par essai.
        </li>
        <li>
          {limits.maxTranscriptions} transcription(s) et {limits.maxRenders} rendu(s) de test maximum ; aperçus en
          basse résolution avec filigrane ({limits.maxPreviewsPerHour} par heure).
        </li>
        <li>
          Le rendu de test reste sur le serveur : aucun téléchargement final sans compte. Import de fichiers locaux
          réservé aux comptes.
        </li>
      </ul>
    </section>
  );
}
