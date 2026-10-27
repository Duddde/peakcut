import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { YoutubeSourcePanel } from "./YoutubeSourcePanel";

const VALID_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

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

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function submitUrl(url = VALID_URL) {
  fireEvent.change(screen.getByLabelText(/lien youtube/i), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: /valider et télécharger/i }));
}

describe("YoutubeSourcePanel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("cannot start a download without a project, and says why", () => {
    render(<YoutubeSourcePanel />);
    fireEvent.change(screen.getByLabelText(/lien youtube/i), { target: { value: VALID_URL } });

    expect(screen.getByRole("button", { name: /valider et télécharger/i })).toBeDisabled();
    expect(screen.getByText(/projet enregistré/i)).toBeInTheDocument();
  });

  it("keeps the public demo button clickable and opens the account gate", () => {
    const onAccountRequired = vi.fn();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    render(<YoutubeSourcePanel requiresAccount onAccountRequired={onAccountRequired} />);
    fireEvent.change(screen.getByLabelText(/lien youtube/i), { target: { value: VALID_URL } });

    const button = screen.getByRole("button", { name: /se connecter pour télécharger/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onAccountRequired).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps the button disabled while the field is empty", () => {
    render(<YoutubeSourcePanel projectId="proj-1" />);
    expect(screen.getByRole("button", { name: /valider et télécharger/i })).toBeDisabled();
  });

  it("queues the download then reports success once the job succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, videoId: "dQw4w9WgXcQ", job: jobPayload() }))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, job: jobPayload({ status: "succeeded", progress: 100 }) })
      );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const onDownloaded = vi.fn();

    render(<YoutubeSourcePanel projectId="proj-1" onDownloaded={onDownloaded} />);
    submitUrl();

    expect(await screen.findByText(/vidéo téléchargée et associée au projet/i)).toBeInTheDocument();
    expect(onDownloaded).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/download-youtube");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      url: VALID_URL,
      projectId: "proj-1",
    });
  });

  it("surfaces the server's own rejection of an invalid link", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ ok: false, error: "Le domaine n'est pas un domaine YouTube reconnu." }, 422)
    ) as unknown as typeof globalThis.fetch;
    const onDownloaded = vi.fn();

    render(<YoutubeSourcePanel projectId="proj-1" onDownloaded={onDownloaded} />);
    submitUrl("https://vimeo.com/123456");

    expect(await screen.findByText(/domaine youtube reconnu/i)).toBeInTheDocument();
    expect(onDownloaded).not.toHaveBeenCalled();
  });

  it("reports a failed download job honestly, with the worker's reason", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, job: jobPayload() }))
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
    const onDownloaded = vi.fn();

    render(<YoutubeSourcePanel projectId="proj-1" onDownloaded={onDownloaded} />);
    submitUrl();

    // Shown once, by JobProgress — the form must not repeat what the progress line already says.
    expect(await screen.findAllByText(/pas accessible publiquement/i)).toHaveLength(1);
    expect(onDownloaded).not.toHaveBeenCalled();
  });

  it("shows real server-reported progress rather than an invented bar", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, job: jobPayload({ status: "running", progress: 42 }) }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, job: jobPayload({ status: "succeeded", progress: 100 }) })) as unknown as typeof globalThis.fetch;

    render(<YoutubeSourcePanel projectId="proj-1" />);
    submitUrl();

    await waitFor(() => {
      expect(screen.getByRole("progressbar", { name: /téléchargement youtube/i })).toBeInTheDocument();
    });
    await screen.findByText(/vidéo téléchargée/i);
    expect(screen.getByRole("progressbar", { name: /téléchargement youtube/i })).toHaveAttribute(
      "aria-valuenow",
      "100"
    );
  });

  it("reports a network failure instead of silently doing nothing", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;

    render(<YoutubeSourcePanel projectId="proj-1" />);
    submitUrl();

    expect(await screen.findByText(/impossible de contacter le serveur/i)).toBeInTheDocument();
  });

  it("disables the button while a download is in flight", async () => {
    let resolveFirst: (value: Response) => void = () => {};
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      })
    ) as unknown as typeof globalThis.fetch;

    render(<YoutubeSourcePanel projectId="proj-1" />);
    submitUrl();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /téléchargement…/i })).toBeDisabled();
    });
    resolveFirst(jsonResponse({ ok: false, error: "Arrêt du test." }, 400));
    await screen.findByText(/arrêt du test/i);
  });

  describe("with the automatic pipeline", () => {
    const PIPELINE = { providerId: "openai", trackProvider: "local-subject" };

    /** download (job-1) → transcription (job-2, last step): the server's chain, as the routes report it. */
    function chainFetch() {
      const download = jobPayload({
        payload: { url: VALID_URL, __chain: [{ kind: "transcription", payload: { providerId: "openai" } }] },
      });
      const transcription = jobPayload({
        id: "job-2",
        kind: "transcription",
        status: "succeeded",
        progress: 100,
        payload: { providerId: "openai" },
        idempotencyKey: "chain:job-1",
      });
      return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/download-youtube") return jsonResponse({ ok: true, job: download }, 201);
        if (url === "/api/jobs/job-1") return jsonResponse({ ok: true, job: { ...download, status: "succeeded", progress: 100 } });
        if (url === "/api/projects/proj-1/jobs") return jsonResponse({ ok: true, jobs: [transcription] });
        if (url === "/api/jobs/job-2") return jsonResponse({ ok: true, job: transcription });
        throw new Error(`unexpected fetch ${url}`);
      });
    }

    it("starts the whole pipeline as soon as a valid link is pasted, without a click", async () => {
      const fetchMock = chainFetch();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const onDownloaded = vi.fn();

      render(<YoutubeSourcePanel projectId="proj-1" pipeline={PIPELINE} onDownloaded={onDownloaded} />);
      fireEvent.paste(screen.getByLabelText(/lien youtube/i), {
        clipboardData: { getData: () => VALID_URL },
      });

      await waitFor(() => expect(onDownloaded).toHaveBeenCalledTimes(1));
      // The last step ends the walk: nothing is looked up after it.
      expect(onDownloaded.mock.calls[0][0].id).toBe("job-2");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/download-youtube");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        url: VALID_URL,
        projectId: "proj-1",
        pipeline: PIPELINE,
      });
      expect(screen.getByText(/transcription mot à mot/i)).toBeInTheDocument();
    });

    it("lets a pasted text that is not a YouTube link through, without starting anything", () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      render(<YoutubeSourcePanel projectId="proj-1" pipeline={PIPELINE} />);
      fireEvent.paste(screen.getByLabelText(/lien youtube/i), {
        clipboardData: { getData: () => "pas un lien" },
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("starts on a link handed over by the projects list", async () => {
      const fetchMock = chainFetch();
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const onDownloaded = vi.fn();

      render(
        <YoutubeSourcePanel projectId="proj-1" pipeline={PIPELINE} autoSubmitUrl={VALID_URL} onDownloaded={onDownloaded} />
      );

      await waitFor(() => expect(onDownloaded).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/download-youtube")).toHaveLength(1);
    });
  });
});
