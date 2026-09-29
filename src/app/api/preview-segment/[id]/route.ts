import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { previewOutputPath } from "@/lib/ffmpeg/previewStorage";

export interface PreviewFileHandlerOptions {
  previewsBaseDir: string;
  maxAgeMs?: number;
}

export function createPreviewSegmentFileHandler(options: PreviewFileHandlerOptions) {
  const maxAgeMs = options.maxAgeMs ?? 15 * 60 * 1000;
  return async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ ok: false, error: "Aperçu introuvable." }, { status: 404 });
    const filePath = previewOutputPath(options.previewsBaseDir, id);
    try {
      const info = await stat(filePath);
      if (Date.now() - info.mtimeMs > maxAgeMs) return NextResponse.json({ ok: false, error: "Aperçu expiré ou introuvable." }, { status: 404 });
      const data = await readFile(filePath);
      return new NextResponse(data, { headers: { "content-type": "video/mp4", "cache-control": "private, max-age=300", "content-disposition": "inline" } });
    } catch {
      return NextResponse.json({ ok: false, error: "Aperçu expiré ou introuvable." }, { status: 404 });
    }
  };
}

export const GET = createPreviewSegmentFileHandler({
  previewsBaseDir: process.env.PEAKCUT_PREVIEW_DIR ?? `${process.cwd()}/.data/previews`,
});
