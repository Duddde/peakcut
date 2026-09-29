import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { StudioSection } from "./StudioSection";
import type { Project } from "@/lib/domain/types";

function makeProject(): Project {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "demo-project",
    title: "Démo",
    createdAt: now,
    updatedAt: now,
    status: "ready-for-review",
    source: {
      id: "demo-source",
      type: "local-upload",
      title: "clip-demo-local.mp4",
      durationSec: 12,
      originTimestamp: now,
      confidence: 1,
    },
    transcript: null,
    segments: [
      {
        id: "demo-segment-1",
        projectId: "demo-project",
        title: "Segment démo initial",
        startSec: 0,
        endSec: 5,
        words: [{ text: "Bonjour", startSec: 0, endSec: 0.4, speaker: "A", confidence: 0.9 }],
        safeZones: [],
        variants: [
          { id: "v1", label: "Vertical", aspectRatio: "9:16", crop: { x: 0, y: 0, width: 1, height: 1 } },
        ],
        score: {
          value: 42,
          confidence: 0.5,
          explanation: {
            breakdown: {
              hook: 0.1,
              lexicalDensity: 0.1,
              question: 0,
              emotion: 0,
              speakerChange: 0,
              duration: 0.1,
              penalties: 0,
            },
            reasons: [],
            penaltyReasons: [],
          },
        },
      },
    ],
    timeline: { clips: [], totalDurationSec: 5 },
    workflow: {
      phase: "analysis_preview",
      publicationPolicy: "publication_never_implicit",
      rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
    },
  };
}

function analyzeSuccessPayload() {
  return {
    ok: true,
    segments: [
      {
        id: "analyzed-1",
        rank: 1,
        title: "Segment analysé prioritaire",
        start_sec: 0,
        end_sec: 4,
        score: 88,
        confidence: 0.7,
        score_breakdown: {
          hook: 0.9,
          lexical_density: 0.6,
          question: 0,
          emotion: 0.2,
          speaker_change: 0.1,
          duration: 0.9,
          penalties: 0,
        },
        categories: ["accroche"],
        reasons: ["Accroche forte"],
        penalty_reasons: [],
        words: [{ text: "Salut", start_sec: 0, end_sec: 0.4, speaker: "A", confidence: 0.9 }],
        safe_zones: [],
        variants: [
          { id: "av1", label: "Vertical", aspect_ratio: "9:16", crop: { x: 0, y: 0, width: 1, height: 1 } },
        ],
      },
    ],
  };
}

describe("StudioSection", () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-preview-url");
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the ingestion panel and the initial demo source", () => {
    render(<StudioSection initialProject={makeProject()} />);
    expect(screen.getByText(/choisir un fichier local/i)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("current-source-card")).getByText(/clip-demo-local\.mp4/)
    ).toBeInTheDocument();
    expect(screen.getByText(/segment démo initial/i)).toBeInTheDocument();
  });

  it("replaces demo segments with the analysis results on success", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/analyze")) {
        return {
          ok: true,
          status: 200,
          json: async () => analyzeSuccessPayload(),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    render(<StudioSection initialProject={makeProject()} />);
    fireEvent.click(screen.getByRole("button", { name: /lancer l'analyse/i }));

    expect(await screen.findByText(/segment analysé prioritaire/i)).toBeInTheDocument();
    expect(screen.queryByText(/segment démo initial/i)).not.toBeInTheDocument();
  });

  it("shows an error status and keeps existing segments when analysis fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: "Erreur serveur." }),
    }) as unknown as typeof fetch;

    render(<StudioSection initialProject={makeProject()} />);
    fireEvent.click(screen.getByRole("button", { name: /lancer l'analyse/i }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /statut de l'analyse/i })).toHaveTextContent(
        /erreur serveur/i
      )
    );
    expect(screen.getByText(/segment démo initial/i)).toBeInTheDocument();
  });

  it("updates the displayed source after a successful ingestion", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ingest-media")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            source: {
              id: "new-source",
              type: "local-upload",
              title: "vraie-video.mp4",
              localFilePath: "/data/uploads/abc.mp4",
              durationSec: 20,
              originTimestamp: "2026-02-02T00:00:00.000Z",
              confidence: 1,
            },
            workflow: {
              phase: "analysis_preview",
              publicationPolicy: "publication_never_implicit",
              rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    render(<StudioSection initialProject={makeProject()} />);
    const input = screen.getByLabelText(/choisir un fichier/i);
    const file = new File([new Uint8Array(10)], "vraie-video.mp4", { type: "video/mp4" });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /importer/i }));

    await waitFor(() =>
      expect(
        within(screen.getByTestId("current-source-card")).getByText(/vraie-video\.mp4/)
      ).toBeInTheDocument()
    );
    expect(within(screen.getByTestId("current-source-card")).getByText(/20\.0s/)).toBeInTheDocument();
  });

  it("disables the transcribe button when no real local media has been imported (demo source has no localFilePath)", () => {
    render(<StudioSection initialProject={makeProject()} />);
    expect(screen.getByRole("button", { name: /transcrire ce média/i })).toBeDisabled();
    expect(screen.getByText(/importez un média local/i)).toBeInTheDocument();
  });

  it("populates the provider selector from /api/transcript-providers, disabling unconfigured options", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/transcript-providers")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            providers: [
              { id: "mock-deterministic", display_name: "Démo déterministe", configured: true },
              { id: "openai-gpt-4o-transcribe-diarize", display_name: "OpenAI", configured: false },
            ],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    render(<StudioSection initialProject={makeProject()} />);
    expect(await screen.findByRole("option", { name: "OpenAI (non configuré)" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Démo déterministe" })).toBeEnabled();
  });

  it("ingests a real local file, then transcribing replaces the segments and reports the provider used", async () => {
    const onIngestResponse = {
      ok: true,
      status: 201,
      json: async () => ({
        ok: true,
        source: {
          id: "new-source",
          type: "local-upload",
          title: "vraie-video.mp4",
          localFilePath: "/data/uploads/abc.mp4",
          durationSec: 20,
          originTimestamp: "2026-02-02T00:00:00.000Z",
          confidence: 1,
        },
        workflow: {
          phase: "analysis_preview",
          publicationPolicy: "publication_never_implicit",
          rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
        },
      }),
    } as Response;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ingest-media")) return onIngestResponse;
      if (url.includes("/api/transcript-providers")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            providers: [{ id: "mock-deterministic", display_name: "Démo déterministe", configured: true }],
          }),
        } as Response;
      }
      if (url.includes("/api/transcribe")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            provider_id: "mock-deterministic",
            transcript: {
              language: "fr",
              words: [
                { text: "Nouveau", start_sec: 0, end_sec: 0.4, speaker: "A", confidence: 0.9 },
                { text: "transcript", start_sec: 0.5, end_sec: 1.0, speaker: "A", confidence: 0.9 },
              ],
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    render(<StudioSection initialProject={makeProject()} />);

    // Before ingestion, transcription must stay disabled.
    expect(screen.getByRole("button", { name: /transcrire ce média/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/choisir un fichier/i), {
      target: { files: [new File([new Uint8Array(10)], "vraie-video.mp4", { type: "video/mp4" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /importer/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /transcrire ce média/i })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /transcrire ce média/i }));

    expect((await screen.findAllByText(/segment transcrit/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/segment démo initial/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: /statut de la transcription/i })).toHaveTextContent(
        /mock-deterministic/i
      )
    );
  });

  it("shows an error status when transcription fails, without touching existing segments", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ingest-media")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            source: {
              id: "new-source",
              type: "local-upload",
              title: "vraie-video.mp4",
              localFilePath: "/data/uploads/abc.mp4",
              durationSec: 20,
              originTimestamp: "2026-02-02T00:00:00.000Z",
              confidence: 1,
            },
            workflow: {
              phase: "analysis_preview",
              publicationPolicy: "publication_never_implicit",
              rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
            },
          }),
        } as Response;
      }
      if (url.includes("/api/transcript-providers")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            providers: [{ id: "mock-deterministic", display_name: "Démo déterministe", configured: true }],
          }),
        } as Response;
      }
      if (url.includes("/api/transcribe")) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ ok: false, error: "Fournisseur non configuré." }),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;

    render(<StudioSection initialProject={makeProject()} />);
    fireEvent.change(screen.getByLabelText(/choisir un fichier/i), {
      target: { files: [new File([new Uint8Array(10)], "vraie-video.mp4", { type: "video/mp4" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: /importer/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /transcrire ce média/i })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /transcrire ce média/i }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: /statut de la transcription/i })).toHaveTextContent(
        /fournisseur non configuré/i
      )
    );
    expect(screen.getAllByText(/segment démo initial/i).length).toBeGreaterThan(0);
  });
});
