/**
 * Strict structural validation of a public YouTube URL.
 *
 * This function performs NO network I/O — it never fetches the URL, never
 * calls the YouTube Data API, and never downloads any media. "Public" here
 * means "shaped like a normal watch/share link to a single video", which is
 * the only thing verifiable without contacting YouTube. Actual visibility
 * (public/unlisted/private) can only be known by YouTube itself.
 */

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);

const YOUTU_BE_HOST = "youtu.be";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export type YoutubeUrlValidationResult =
  | { ok: true; videoId: string; normalizedUrl: string }
  | { ok: false; error: string };

function isValidVideoId(id: string | null | undefined): id is string {
  return typeof id === "string" && VIDEO_ID_PATTERN.test(id);
}

function buildNormalizedUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function validateYoutubeUrl(input: string): YoutubeUrlValidationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "URL vide." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "URL invalide." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "Seuls les protocoles http et https sont acceptés." };
  }

  if (url.username || url.password) {
    return { ok: false, error: "L'URL ne doit pas contenir d'identifiants." };
  }

  const host = url.hostname.toLowerCase();

  if (host === YOUTU_BE_HOST) {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0];
    if (!isValidVideoId(id)) {
      return { ok: false, error: "Identifiant de vidéo youtu.be invalide." };
    }
    return { ok: true, videoId: id, normalizedUrl: buildNormalizedUrl(id) };
  }

  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, error: "Le domaine n'est pas un domaine YouTube reconnu." };
  }

  const segments = url.pathname.split("/").filter(Boolean);

  // /watch?v=<id>
  if (segments.length === 1 && segments[0] === "watch") {
    const id = url.searchParams.get("v");
    if (!isValidVideoId(id)) {
      return { ok: false, error: "Paramètre v manquant ou invalide." };
    }
    return { ok: true, videoId: id, normalizedUrl: buildNormalizedUrl(id) };
  }

  // /shorts/<id> or /embed/<id>
  if (segments.length >= 2 && (segments[0] === "shorts" || segments[0] === "embed")) {
    const id = segments[1];
    if (!isValidVideoId(id)) {
      return { ok: false, error: "Identifiant de vidéo invalide." };
    }
    return { ok: true, videoId: id, normalizedUrl: buildNormalizedUrl(id) };
  }

  return {
    ok: false,
    error:
      "L'URL doit pointer vers une vidéo unique (watch, shorts ou embed), pas une playlist, une chaîne ou un profil.",
  };
}
