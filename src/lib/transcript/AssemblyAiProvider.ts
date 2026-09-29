import { readFile } from "node:fs/promises";
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
  sleep,
  TranscriptInvalidPayloadError,
  TranscriptTimeoutError,
  type FetchLike,
} from "./transcriptHttp";
import { convertAssemblyAiTranscript } from "./assemblyai/convertAssemblyAiTranscript";

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 40; // 40 * 3s = 120s bounded polling window by default.

export interface AssemblyAiProviderDeps {
  /** Injectable fetch, used by tests to avoid any real network access. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  /** Injectable sleep, used by tests to avoid waiting in real time between polls. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Real adapter for AssemblyAI's speech-to-text + diarization API:
 * 1. POST /v2/upload — uploads the local file's raw bytes.
 * 2. POST /v2/transcript — creates a transcription job with
 *    `speaker_labels: true` against the uploaded audio URL.
 * 3. GET /v2/transcript/:id — polled at a fixed interval, bounded by
 *    `maxPollAttempts`, until `status` is "completed" or "error".
 *
 * Only ever calls the network if `ASSEMBLYAI_API_KEY` is set; otherwise
 * throws TranscriptProviderNotConfiguredError immediately with no
 * fallback. The key is only ever read from the environment and placed in
 * the `authorization` header of the outgoing requests — never logged.
 */
export class AssemblyAiProvider implements TranscriptProvider {
  readonly id = "assemblyai";
  readonly displayName = "AssemblyAI";

  constructor(private readonly deps: AssemblyAiProviderDeps = {}) {}

  async transcribe(request: TranscriptRequest): Promise<Transcript> {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    if (!apiKey) {
      throw new TranscriptProviderNotConfiguredError(this.id, "ASSEMBLYAI_API_KEY");
    }

    await assertLocalFileExists(request.mediaPath);
    const data = await readFile(request.mediaPath);

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxPollAttempts = this.deps.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
    const sleepImpl = this.deps.sleepImpl ?? sleep;

    const uploadUrl = await this.upload(fetchImpl, apiKey, data, timeoutMs);
    const transcriptId = await this.createTranscript(fetchImpl, apiKey, uploadUrl, request.languageHint, timeoutMs);
    const finalPayload = await this.pollUntilDone(
      fetchImpl,
      apiKey,
      transcriptId,
      timeoutMs,
      pollIntervalMs,
      maxPollAttempts,
      sleepImpl
    );

    return convertAssemblyAiTranscript(finalPayload, this.id);
  }

  private async upload(fetchImpl: FetchLike, apiKey: string, data: Buffer, timeoutMs: number): Promise<string> {
    const res = await fetchWithTimeout(
      fetchImpl,
      this.id,
      `${ASSEMBLYAI_BASE_URL}/upload`,
      {
        method: "POST",
        headers: { authorization: apiKey, "content-type": "application/octet-stream" },
        // Node's fetch/undici accepts a Buffer body at runtime; only the DOM-lib BodyInit
        // type (used for browser fetch) doesn't declare it, hence the cast.
        body: data as unknown as BodyInit,
      },
      timeoutMs
    );
    await assertOkResponse(res, this.id);
    const json = (await parseJsonResponse(res, this.id)) as Record<string, unknown>;
    if (typeof json.upload_url !== "string") {
      throw new TranscriptInvalidPayloadError(this.id, "upload_url manquant dans la réponse d'upload.");
    }
    return json.upload_url;
  }

  private async createTranscript(
    fetchImpl: FetchLike,
    apiKey: string,
    audioUrl: string,
    languageHint: string | undefined,
    timeoutMs: number
  ): Promise<string> {
    const res = await fetchWithTimeout(
      fetchImpl,
      this.id,
      `${ASSEMBLYAI_BASE_URL}/transcript`,
      {
        method: "POST",
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: audioUrl,
          speaker_labels: true,
          ...(languageHint ? { language_code: languageHint } : {}),
        }),
      },
      timeoutMs
    );
    await assertOkResponse(res, this.id);
    const json = (await parseJsonResponse(res, this.id)) as Record<string, unknown>;
    if (typeof json.id !== "string") {
      throw new TranscriptInvalidPayloadError(this.id, "id de transcription manquant.");
    }
    return json.id;
  }

  private async pollUntilDone(
    fetchImpl: FetchLike,
    apiKey: string,
    transcriptId: string,
    timeoutMs: number,
    pollIntervalMs: number,
    maxPollAttempts: number,
    sleepImpl: (ms: number) => Promise<void>
  ): Promise<unknown> {
    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      const res = await fetchWithTimeout(
        fetchImpl,
        this.id,
        `${ASSEMBLYAI_BASE_URL}/transcript/${transcriptId}`,
        { method: "GET", headers: { authorization: apiKey } },
        timeoutMs
      );
      await assertOkResponse(res, this.id);
      const json = (await parseJsonResponse(res, this.id)) as Record<string, unknown>;
      const status = typeof json.status === "string" ? json.status : null;

      if (status === "completed") {
        return json;
      }
      if (status === "error") {
        throw new TranscriptInvalidPayloadError(
          this.id,
          `AssemblyAI a renvoyé une erreur de transcription : ${String(json.error ?? "inconnue")}.`
        );
      }

      if (attempt < maxPollAttempts - 1) {
        await sleepImpl(pollIntervalMs);
      }
    }

    throw new TranscriptTimeoutError(this.id, pollIntervalMs * maxPollAttempts);
  }
}
