import { randomUUID } from "node:crypto";
import type { Source } from "@/lib/domain/types";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import { validateUploadMetadata } from "./validateUpload";
import type { MediaStorage } from "./mediaStorage";

export class IngestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionValidationError";
  }
}

export interface IngestMediaInput {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface IngestMediaDeps {
  now?: () => string;
  /** Best-effort real media duration probe (e.g. ffprobe). Failure never blocks ingestion. */
  probeDurationSec?: (storedPath: string) => Promise<number>;
}

export interface IngestMediaResult {
  source: Source;
  workflow: ReturnType<typeof createInitialWorkflow>;
}

/**
 * Validates and stores a user-supplied local media file, then returns the
 * Source + initial WorkflowState PeakCut will attach to a project. This
 * never downloads anything from YouTube or any other remote service — the
 * bytes must already have been supplied by the caller.
 */
export async function ingestMedia(
  input: IngestMediaInput,
  storage: MediaStorage,
  deps: IngestMediaDeps = {}
): Promise<IngestMediaResult> {
  const validation = validateUploadMetadata({
    filename: input.filename,
    sizeBytes: input.data.length,
    mimeType: input.mimeType,
  });
  if (!validation.ok) {
    throw new IngestionValidationError(validation.error);
  }

  const stored = await storage.save(input.filename, input.data);

  let durationSec = 0;
  if (deps.probeDurationSec) {
    try {
      durationSec = await deps.probeDurationSec(stored.storedPath);
    } catch {
      durationSec = 0;
    }
  }

  const now = deps.now ? deps.now() : new Date().toISOString();

  const source: Source = {
    id: randomUUID(),
    type: "local-upload",
    title: input.filename,
    localFilePath: stored.storedPath,
    durationSec,
    originTimestamp: now,
    confidence: 1,
  };

  return { source, workflow: createInitialWorkflow() };
}
