import { NextRequest, NextResponse } from "next/server";
import { validateYoutubeUrl } from "@/lib/youtube/validateYoutubeUrl";

/**
 * Strictly validates that a submitted URL is a well-formed public YouTube
 * video link, and nothing more: this endpoint performs no download, no
 * call to any YouTube API, and no publishing action. Fetching the video
 * is a separate, authenticated, per-project action — see
 * /api/download-youtube.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Corps de requête JSON invalide." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || !("url" in body) || typeof (body as { url: unknown }).url !== "string") {
    return NextResponse.json({ ok: false, error: "Le champ 'url' est requis et doit être une chaîne." }, { status: 400 });
  }

  const result = validateYoutubeUrl((body as { url: string }).url);

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  }

  return NextResponse.json(
    { ok: true, videoId: result.videoId, normalizedUrl: result.normalizedUrl },
    { status: 200 }
  );
}
