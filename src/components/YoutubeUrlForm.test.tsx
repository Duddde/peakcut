import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { YoutubeUrlForm } from "./YoutubeUrlForm";
import { describePublicTrialLimits } from "@/lib/publicTrial/config";

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
/** GET /api/public-trial when PEAKCUT_PUBLIC_TRIAL is off: the account path applies. */
const TRIAL_OFF = jsonResponse({ ok: true, enabled: false });

/** The happy path: validate, check the trial (off), create the project, queue the download, poll it to success. */
function mockFullChain() {
  return vi
    .fn()
    .mockResolvedValueOnce(VALIDATION_OK)
    .mockResolvedValueOnce(TRIAL_OFF)
    .mockResolvedValueOnce(PROJECT_OK)
    .mockResolvedValueOnce(QUEUED_OK)
    .mockResolvedValueOnce(JOB_DONE);
}

function submit(url = VALID_URL) {
  fireEvent.change(screen.getByLabelText(/lien youtube/i), { target: { value: url } });
  fireEvent.click(screen.getByRole("button", { name: /valider le lien/i }));
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
    expect(screen.getByRole("button", { name: /valider le lien/i })).toBeDisabled();
  });

  it("describes the trial path and its safeguards in the input's help text", () => {
    render(<YoutubeUrlForm />);
    const help = document.getElementById("youtube-url-help");
    expect(help).not.toBeNull();
    expect(screen.getByLabelText(/lien youtube/i)).toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("youtube-url-help")
    );
    expect(help).toHaveTextContent(
      "Le lien est d'abord vérifié. Après confirmation de vos droits sur la vidéo, elle peut être téléchargée et traitée sans compte via l'essai public."
    );
    expect(help).toHaveTextContent(
      "Rien n'est publié : l'export de test reste filigrané, et détenir les droits sur la vidéo reste obligatoire."
    );
    expect(help).not.toHaveTextContent(/quand il est ouvert/i);
  });

  it("offers the demo as its own block, with the words correctly spaced", () => {
    render(<YoutubeUrlForm />);
    const link = screen.getByRole("link", { name: "plus bas" });
    expect(link).toHaveAttribute("href", "#studio");
    // The arrow and the sentence are separate flex items (spaced by `gap`), so they can never run together.
    const sentence = link.parentElement;
    expect(sentence?.textContent).toBe("Essayez la démonstration sans créer de compte plus bas");
    const offer = sentence?.parentElement ?? null;
    expect(offer).toHaveClass("flex");
    expect(offer?.firstElementChild).toHaveTextContent("↳");
    expect(offer?.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(document.getElementById("youtube-url-help")).not.toContainElement(offer);
  });

  it("validates then really downloads the video on a single click", async () => {
    const fetchMock = mockFullChain();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    expect(await screen.findByText(/vidéo téléchargée/i)).toBeInTheDocument();

    const calledUrls = fetchMock.mock.calls.map((call) => call[0]);
    expect(calledUrls.slice(0, 4)).toEqual([
      "/api/validate-youtube-url",
      "/api/public-trial",
      "/api/projects",
      "/api/download-youtube",
    ]);

    const downloadBody = JSON.parse(fetchMock.mock.calls[3][1].body as string);
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

  it("shows the validated link without opening the account gate for a signed-out visitor (trial off)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(VALIDATION_OK)
      .mockResolvedValueOnce(TRIAL_OFF)
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "Non authentifié." }, 401))
      .mockResolvedValueOnce(TRIAL_OFF);
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<YoutubeUrlForm />);
    submit();

    expect(await screen.findByText(/lien youtube valide/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /un compte est nécessaire/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /démarrer l'essai public/i })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/validate-youtube-url",
      "/api/public-trial",
      "/api/projects",
      "/api/public-trial",
    ]);
  });

  describe("public trial (server reports PEAKCUT_PUBLIC_TRIAL=1)", () => {
    // The real summary GET /api/public-trial returns — a fixture missing a
    // field would be rejected by the client and read as "trial off".
    const TRIAL_LIMITS = describePublicTrialLimits();
    const TRIAL_STATUS = jsonResponse({ ok: true, enabled: true, account: false, limits: TRIAL_LIMITS, trial: null });
    const TRIAL_STARTED = jsonResponse(
      { ok: true, trial: { active: true, expiresAt: "2026-01-01T02:00:00.000Z" }, limits: TRIAL_LIMITS },
      201
    );

    it("shows the limits and requires the rights confirmation before starting the trial", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(VALIDATION_OK)
        .mockResolvedValueOnce(TRIAL_STATUS);
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      render(<YoutubeUrlForm />);
      submit();

      const notice = await screen.findByRole("region", { name: /limites de l'essai public/i });
      expect(notice).toHaveTextContent(/60 min et 2 Go maximum/);
      expect(notice).toHaveTextContent(/10 téléchargement\(s\) par essai/);
      expect(notice).toHaveTextContent(/aucun téléchargement final sans compte/i);
      const start = screen.getByRole("button", { name: /démarrer l'essai public/i });
      expect(start).toBeDisabled();
      fireEvent.click(start);
      // Straight from validation to the offer: no project creation was attempted (and no 401 waited on).
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/validate-youtube-url", "/api/public-trial"]);
      expect(fetchMock.mock.calls[1][1]).not.toMatchObject({ method: "POST" });
      expect(screen.queryByRole("dialog", { name: /un compte est nécessaire/i })).not.toBeInTheDocument();
    });

    it("starts the trial, then creates the ephemeral project and downloads, without AccountGate", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(VALIDATION_OK)
        .mockResolvedValueOnce(TRIAL_STATUS)
        .mockResolvedValueOnce(TRIAL_STARTED)
        .mockResolvedValueOnce(PROJECT_OK)
        .mockResolvedValueOnce(QUEUED_OK)
        .mockResolvedValueOnce(JOB_DONE);
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      render(<YoutubeUrlForm />);
      submit();

      fireEvent.click(await screen.findByRole("checkbox", { name: /je confirme détenir les droits/i }));
      fireEvent.click(screen.getByRole("button", { name: /démarrer l'essai public/i }));

      const link = await screen.findByRole("link", { name: /ouvrir le projet/i });
      expect(link).toHaveAttribute("href", "/projects/proj-1");
      expect(screen.getByText(/projet d'essai éphémère/i)).toBeInTheDocument();
      expect(fetchMock.mock.calls.map((call) => call[0]).slice(0, 5)).toEqual([
        "/api/validate-youtube-url",
        "/api/public-trial",
        "/api/public-trial",
        "/api/projects",
        "/api/download-youtube",
      ]);
      expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST" });
      // The trial route refuses a download without the visitor's own rights confirmation.
      expect(JSON.parse(fetchMock.mock.calls[4][1].body as string)).toEqual({
        url: VALID_URL,
        projectId: "proj-1",
        rightsConfirmed: true,
      });
      expect(screen.queryByRole("dialog", { name: /un compte est nécessaire/i })).not.toBeInTheDocument();
    });

    it("surfaces a refused trial start (capacity, rate limit) instead of continuing", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(VALIDATION_OK)
        .mockResolvedValueOnce(TRIAL_STATUS)
        .mockResolvedValueOnce(jsonResponse({ ok: false, error: "L'essai public est complet pour le moment." }, 503));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      render(<YoutubeUrlForm />);
      submit();
      fireEvent.click(await screen.findByRole("checkbox", { name: /je confirme détenir les droits/i }));
      fireEvent.click(screen.getByRole("button", { name: /démarrer l'essai public/i }));

      expect(await screen.findByText(/essai public est complet/i)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("shows a visible message while the trial status is being checked", async () => {
      let resolveStatus: (value: Response) => void = () => {};
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(VALIDATION_OK)
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveStatus = resolve;
            })
        ) as unknown as typeof globalThis.fetch;

      render(<YoutubeUrlForm />);
      submit();

      expect(await screen.findByText(/vérification de l'accès/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /vérification…/i })).toBeDisabled();
      resolveStatus(TRIAL_STATUS);
      expect(await screen.findByRole("button", { name: /démarrer l'essai public/i })).toBeInTheDocument();
      expect(screen.queryByText(/vérification de l'accès/i)).not.toBeInTheDocument();
    });

    it("shows a visible message while the trial is starting", async () => {
      let resolveStart: (value: Response) => void = () => {};
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(VALIDATION_OK)
        .mockResolvedValueOnce(TRIAL_STATUS)
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveStart = resolve;
            })
        ) as unknown as typeof globalThis.fetch;

      render(<YoutubeUrlForm />);
      submit();
      fireEvent.click(await screen.findByRole("checkbox", { name: /je confirme détenir les droits/i }));
      fireEvent.click(screen.getByRole("button", { name: /démarrer l'essai public/i }));

      expect(await screen.findByText(/démarrage de l'essai public…/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /démarrage…/i })).toBeDisabled();
      resolveStart(jsonResponse({ ok: false, error: "Arrêt du test." }, 503));
      await screen.findByText(/arrêt du test/i);
    });

    it("keeps the account path when an account is already signed in", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(VALIDATION_OK)
        .mockResolvedValueOnce(
          jsonResponse({ ok: true, enabled: true, account: true, limits: TRIAL_LIMITS, trial: null })
        )
        .mockResolvedValueOnce(PROJECT_OK)
        .mockResolvedValueOnce(QUEUED_OK)
        .mockResolvedValueOnce(JOB_DONE);
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      render(<YoutubeUrlForm />);
      submit();

      expect(await screen.findByText(/vidéo téléchargée/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /démarrer l'essai public/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/projet d'essai éphémère/i)).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.map((call) => call[0]).slice(0, 4)).toEqual([
        "/api/validate-youtube-url",
        "/api/public-trial",
        "/api/projects",
        "/api/download-youtube",
      ]);
      // An account download carries no trial rights flag.
      expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({ url: VALID_URL, projectId: "proj-1" });
    });
  });

  it("shows real server-reported download progress", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(VALIDATION_OK)
      .mockResolvedValueOnce(TRIAL_OFF)
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
      .mockResolvedValueOnce(TRIAL_OFF)
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
      .mockResolvedValueOnce(TRIAL_OFF)
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
    expect(screen.getByText(/vérification du lien youtube/i)).toBeInTheDocument();
    resolveValidation(jsonResponse({ ok: false, error: "Arrêt du test." }, 422));
    await screen.findByText(/arrêt du test/i);
  });
});
