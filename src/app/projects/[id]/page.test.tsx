import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ProjectDetailPage from "./page";
import type { Project } from "@/lib/domain/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "proj-1",
    title: "Mon projet",
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      id: "s0",
      type: "local-upload",
      title: "Aucun média importé",
      durationSec: 0,
      originTimestamp: now,
      confidence: 0,
    },
    transcript: null,
    segments: [],
    timeline: null,
    workflow: {
      phase: "analysis_preview",
      publicationPolicy: "publication_never_implicit",
      rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
    },
    ...overrides,
  };
}

describe("ProjectDetailPage", () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-preview-url");
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a loading state, then mounts the studio with the loaded project", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, project: makeProject() }),
    }) as unknown as typeof fetch;

    render(<ProjectDetailPage params={Promise.resolve({ id: "proj-1" })} />);
    expect(screen.getByText(/chargement du projet/i)).toBeInTheDocument();

    expect(await screen.findByDisplayValue("Mon projet")).toBeInTheDocument();
  });

  it("shows a not-found message on 401", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: "Non authentifié." }),
    }) as unknown as typeof fetch;

    render(<ProjectDetailPage params={Promise.resolve({ id: "proj-1" })} />);
    expect(await screen.findByText(/projet introuvable ou accès refusé/i)).toBeInTheDocument();
  });

  it("shows a not-found message on 404 (ownership denied or missing)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: "Projet introuvable." }),
    }) as unknown as typeof fetch;

    render(<ProjectDetailPage params={Promise.resolve({ id: "proj-1" })} />);
    expect(await screen.findByText(/projet introuvable ou accès refusé/i)).toBeInTheDocument();
  });

  it("saves edits via PATCH and reflects the persisted project on success", async () => {
    const project = makeProject();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/projects/proj-1") && (!init || init.method === undefined)) {
        return { ok: true, status: 200, json: async () => ({ ok: true, project }) } as Response;
      }
      if (url.includes("/api/projects/proj-1") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, project: { ...project, title: body.title, updatedAt: "2026-01-02T00:00:00.000Z" } }),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    render(<ProjectDetailPage params={Promise.resolve({ id: "proj-1" })} />);
    const titleInput = await screen.findByDisplayValue("Mon projet");
    fireEvent.change(titleInput, { target: { value: "Titre modifié" } });

    const saveButton = await screen.findByRole("button", { name: /enregistrer/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/proj-1",
        expect.objectContaining({ method: "PATCH" })
      );
    });
    await screen.findByText(/projet enregistré/i);
  });

  it("keeps local edits when the save request fails", async () => {
    const project = makeProject();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/projects/proj-1") && init?.method === "PATCH") {
        return { ok: false, status: 500, json: async () => ({ ok: false, error: "Erreur serveur." }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, project }) } as Response;
    }) as unknown as typeof fetch;

    render(<ProjectDetailPage params={Promise.resolve({ id: "proj-1" })} />);
    const titleInput = await screen.findByDisplayValue("Mon projet");
    fireEvent.change(titleInput, { target: { value: "Titre local non sauvegardé" } });

    const saveButton = await screen.findByRole("button", { name: /enregistrer/i });
    fireEvent.click(saveButton);

    await screen.findByText(/erreur serveur/i);
    expect(screen.getByDisplayValue("Titre local non sauvegardé")).toBeInTheDocument();
  });
});
