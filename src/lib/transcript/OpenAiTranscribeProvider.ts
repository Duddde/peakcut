import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Transcript } from "@/lib/domain/types";
import {
  TranscriptProviderNotConfiguredError,
  type TranscriptProvider,
  type TranscriptRequest,
} from "./TranscriptProvider";
import {
  assertLocalFileExists,
  assertOkResponse,
  fetchWithTimeout,
  parseJsonResponse,
  type FetchLike,
} from "./transcriptHttp";
import { convertOpenAiDiarizedJson } from "./openai/convertOpenAiDiarizedJson";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OpenAiTranscribeProviderDeps {
  /** Injectable fetch, used by tests to avoid any real network access. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Real adapter for OpenAI's audio transcription endpoint using the
 * `gpt-4o-transcribe-diarize` model and `response_format: "diarized_json"`.
 *
 * - Only ever calls the network if `OPENAI_API_KEY` is set in the
 *   environment; otherwise throws TranscriptProviderNotConfiguredError
 *   immediately, with no fallback of any kind.
 * - Validates the local media file exists before doing anything else.
 * - Uploads the file as multipart/form-data (the officially documented
 *   way to call this endpoint).
 * - Bounds the request with an AbortController-based timeout.
 * - Never logs or embeds the API key; it is read from the environment at
 *   call time and only ever placed in the Authorization header of the
 *   single outgoing request.
 */
export class OpenAiTranscribeProvider implements TranscriptProvider {
  readonly id = "openai-gpt-4o-transcribe-diarize";
  readonly displayName = "OpenAI gpt-4o-transcribe-diarize";

  constructor(private readonly deps: OpenAiTranscribeProviderDeps = {}) {}

  async transcribe(request: TranscriptRequest): Promise<Transcript> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new TranscriptProviderNotConfiguredError(this.id, "OPENAI_API_KEY");
    }

    await assertLocalFileExists(request.mediaPath);
    const data = await readFile(request.mediaPath);

    const formData = new FormData();
    formData.append("file", new Blob([data]), path.basename(request.mediaPath));
    formData.append("model", "gpt-4o-transcribe-diarize");
    formData.append("response_format", "diarized_json");
    if (request.languageHint) {
      formData.append("language", request.languageHint);
    }

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const res = await fetchWithTimeout(
      fetchImpl,
      this.id,
      OPENAI_TRANSCRIPTIONS_URL,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      },
      timeoutMs
    );

    await assertOkResponse(res, this.id);
    const json = await parseJsonResponse(res, this.id);
    return convertOpenAiDiarizedJson(json, this.id);
  }
}
