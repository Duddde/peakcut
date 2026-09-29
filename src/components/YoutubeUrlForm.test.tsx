import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { YoutubeUrlForm } from "./YoutubeUrlForm";

const VALID_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function jobPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    projectId: "proj-1",
    kind: "download",
    status: "queued",
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    payload: { url: VALID_URL },
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    idempotencyKey: null,
    ...overrides,
  };
}

const VALIDATION_OK = jsonResponse({ ok: true, videoId: "dQw4w9WgXcQ", normalizedUrl: VALID_URL });
const PROJECT_OK = jsonResponse({ ok: true, project: { id: "proj-1" } }, 201);
const QUEUED_OK = jsonResponse({ ok: true, videoId: "dQw4w9WgXcQ", job: jobPayload() }, 201);
const JOB_DONE = jsonResponse({ ok: true, job: jobPayload({ status: "succeeded", progress: 100 }) });

/** The happy path: validate, create the project, queue the download, poll it to success. */
function mockFullChain() {
  return vi
    .fn()
    .mockResolvedValueOnce(VALIDATION_OK)
    .mockResolvedValueOnce(PROJECT_OK)
    .mockResolvedValueOnce(QUEUED_OK)
    .mockResolvedValueOnce(JOB_DONE);
}

function submit(url = VALID_URL) {
  fireEvent.change(screen.getByLabelText(/lien youtube/i), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: /valider et télécharger/i }));
}

describe("YoutubeUrlForm", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("keeps the button disabled until a link is typed", () => {
    render(<YoutubeUrlForm />);
    expect(screen.getByRole("button", { name: /valider et télécharger/i })).toBeDisabled();
  });

  it("validates then really downloads the video on a single click", async () => {
    const fetchMock = mockFullChain();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    expect(await screen.findByText(/vidéo téléchargée/i)).toBeInTheDocument();

    const calledUrls = fetchMock.mock.calls.map((call) => call[0]);
    expect(calledUrls.slice(0, 3)).toEqual([
      "/api/validate-youtube-url",
      "/api/projects",
      "/api/download-youtube",
    ]);

    const downloadBody = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(downloadBody).toEqual({ url: VALID_URL, projectId: "proj-1" });
  });

  it("links to the project the downloaded video landed in", async () => {
    globalThis.fetch = mockFullChain() as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    const link = await screen.findByRole("link", { name: /ouvrir le projet/i });
    expect(link).toHaveAttribute("href", "/projects/proj-1");
  });

  it("stops at validation and never downloads an invalid link", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: "Le domaine n'est pas un domaine YouTube reconnu." }, 422)
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit("https://vimeo.com/123456");

    expect(await screen.findByText(/domaine youtube reconnu/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the account gate instead of downloading for a signed-out visitor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(VALIDATION_OK)
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "Non authentifié." }, 401));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    expect(await screen.findByRole("dialog", { name: /un compte est nécessaire/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows real server-reported download progress", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(VALIDATION_OK)
      .mockResolvedValueOnce(PROJECT_OK)
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, job: jobPayload({ status: "running", progress: 37 }) }, 201)
      )
      .mockResolvedValueOnce(JOB_DONE) as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    const bar = await screen.findByRole("progressbar", { name: /téléchargement youtube/i });
    expect(bar).toBeInTheDocument();
    await screen.findByText(/vidéo téléchargée/i);
    expect(screen.getByRole("progressbar", { name: /téléchargement youtube/i })).toHaveAttribute(
      "aria-valuenow",
      "100"
    );
  });

  it("reports a failed download with the worker's own reason", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(VALIDATION_OK)
      .mockResolvedValueOnce(PROJECT_OK)
      .mockResolvedValueOnce(QUEUED_OK)
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          job: jobPayload({
            status: "failed",
            errorCode: "VideoDownloadError",
            errorMessage: "Cette vidéo n'est pas accessible publiquement.",
          }),
        })
      ) as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    // Shown once, by JobProgress — the form must not repeat what the progress line already says.
    expect(await screen.findAllByText(/pas accessible publiquement/i)).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /ouvrir le projet/i })).not.toBeInTheDocument();
  });

  it("surfaces a rejected download request, such as a rate limit", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(VALIDATION_OK)
      .mockResolvedValueOnce(PROJECT_OK)
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: "Trop de téléchargements demandés. Réessayez dans une minute." }, 429)
      ) as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    expect(await screen.findByText(/trop de téléchargements/i)).toBeInTheDocument();
  });

  it("reports a network failure rather than silently doing nothing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    expect(await screen.findByText(/impossible de contacter le serveur/i)).toBeInTheDocument();
  });

  it("disables the button for the whole chain, not just validation", async () => {
    let resolveValidation: (value: Response) => void = () => {};
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveValidation = resolve;
        })
    ) as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /vérification…/i })).toBeDisabled();
    });
    resolveValidation(jsonResponse({ ok: false, error: "Arrêt du test." }, 422));
    await screen.findByText(/arrêt du test/i);
  });
});
