import { readFile, stat } from "node:fs/promises";
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
  TranscriptMediaTooLargeError,
  type FetchLike,
} from "./transcriptHttp";
import { convertOpenAiDiarizedJson } from "./openai/convertOpenAiDiarizedJson";
import { extractAudioForTranscription, type ExtractAudio } from "@/lib/ffmpeg/extractAudioForTranscription";
import { Agent, fetch as undiciFetch, FormData as UndiciFormData } from "undici";

const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

/**
 * The endpoint's documented upload cap. A file above it is rejected
 * outright, so a real 20-minute video never reaches the model as-is.
 */
export const OPENAI_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Transcribing a long recording is minutes of work on the provider's
 * side, upload included — the original 60s bound could only ever have
 * fitted a short clip. Overridable with PEAKCUT_TRANSCRIPT_TIMEOUT_MS.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

function configuredTimeoutMs(): number {
  const raw = Number(process.env.PEAKCUT_TRANSCRIPT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * An AbortController is not enough here. Node's fetch is undici, which
 * applies its own `headersTimeout` — 300s by default — while waiting for
 * the response to start. A 17-minute audio took longer than that to come
 * back, so every attempt died at 5 minutes sharp with a bare
 * "TypeError: fetch failed", whatever the application-level timeout said.
 *
 * The dispatcher below pushes undici's own bounds out to the timeout the
 * caller actually asked for; the AbortController remains what ends the
 * request.
 *
 * Everything comes from the npm package — client, dispatcher and
 * FormData — because the two undici builds cannot be mixed. Handing this
 * Agent to Node's own `fetch` fails outright ("invalid onRequestStart
 * method"), and calling this `fetch` with a Node-global FormData sends an
 * empty body ("you must provide a model parameter"). The body is built
 * with UndiciFormData for that reason.
 */
const agents = new Map<number, Agent>();

function longRequestFetch(timeoutMs: number): FetchLike {
  let agent = agents.get(timeoutMs);
  if (!agent) {
    agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    agents.set(timeoutMs, agent);
  }
  const dispatcher = agent;
  // undici's Response carries the same members the callers use (.ok,
  // .status, .json(), .text()); only its declaration differs from the DOM
  // one, hence the cast.
  return ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) =>
    undiciFetch(String(input), {
      ...init,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1])) as unknown as FetchLike;
}

export interface OpenAiTranscribeProviderDeps {
  /** Injectable fetch, used by tests to avoid any real network access. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Injected in tests; defaults to the real ffmpeg-backed extraction. */
  extractAudio?: ExtractAudio;
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

    /**
     * Only an oversized file is re-encoded. A clip that already fits is
     * uploaded untouched — that keeps the common path free of ffmpeg and
     * of a needless quality loss, and it is why a deployment without
     * ffmpeg still transcribes short media.
     */
    const { size } = await stat(request.mediaPath);
    let uploadPath = request.mediaPath;
    let cleanup: (() => Promise<void>) | null = null;

    if (size > OPENAI_MAX_UPLOAD_BYTES) {
      const extracted = await (this.deps.extractAudio ?? extractAudioForTranscription)(request.mediaPath);
      cleanup = extracted.cleanup;
      if (extracted.sizeBytes > OPENAI_MAX_UPLOAD_BYTES) {
        await cleanup();
        throw new TranscriptMediaTooLargeError(this.id, extracted.sizeBytes, OPENAI_MAX_UPLOAD_BYTES);
      }
      uploadPath = extracted.path;
    }

    try {
      const data = await readFile(uploadPath);

      // UndiciFormData, not the global one: see longRequestFetch.
      const formData = new UndiciFormData();
      // A File, not a Blob: UndiciFormData rejects a Node-global Blob,
      // and the filename's extension is how the endpoint detects the
      // audio format.
      formData.append("file", new File([data], path.basename(uploadPath)));
      formData.append("model", "gpt-4o-transcribe-diarize");
      formData.append("response_format", "diarized_json");
      // Required by the diarization model: without it the endpoint answers
      // 400 "chunking_strategy is required for diarization models",
      // whatever the clip's length. "auto" lets OpenAI segment the audio
      // itself, which is what the documented example does.
      formData.append("chunking_strategy", "auto");
      if (request.languageHint) {
        formData.append("language", request.languageHint);
      }

      const timeoutMs = this.deps.timeoutMs ?? configuredTimeoutMs();
      const fetchImpl = this.deps.fetchImpl ?? longRequestFetch(timeoutMs);

      const res = await fetchWithTimeout(
        fetchImpl,
        this.id,
        OPENAI_TRANSCRIPTIONS_URL,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          // UndiciFormData is a valid multipart body for undici's fetch;
          // only the DOM typing of RequestInit does not know about it.
          body: formData as unknown as BodyInit,
        },
        timeoutMs
      );

      await assertOkResponse(res, this.id);
      const json = await parseJsonResponse(res, this.id);
      return convertOpenAiDiarizedJson(json, this.id, request.languageHint);
    } finally {
      await cleanup?.();
    }
  }
}
