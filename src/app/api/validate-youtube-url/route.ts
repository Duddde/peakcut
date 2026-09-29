import { NextRequest, NextResponse } from "next/server";
import { validateYoutubeUrl } from "@/lib/youtube/validateYoutubeUrl";

/**
 * Strictly validates that a submitted URL is a well-formed public YouTube
 * video link. This endpoint performs NO download of the video, NO call to
 * any YouTube API, and NO publishing action of any kind — it only checks
 * the shape of the URL string itself.
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
