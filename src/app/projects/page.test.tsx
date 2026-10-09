import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProjectsPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("ProjectsPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    push.mockReset();
  });

  it("shows the public demo cards and the exploration banner without a session", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(401, { ok: false })) as unknown as typeof fetch;

    render(<ProjectsPage />);

    expect(await screen.findByRole("region", { name: /mode exploration/i })).toHaveTextContent(
      /personnalisation.*sauvegarde.*connexion/i
    );
    const demoLink = await screen.findByRole("link", { name: /podcast · les signaux faibles/i });
    expect(demoLink).toHaveAttribute("href", "/projects/demo-podcast");
    expect(screen.getByRole("link", { name: /démo peakcut — vidéo d'exemple/i })).toHaveAttribute(
      "href",
      "/projects/demo-project"
    );
    expect(screen.getByRole("link", { name: /se connecter/i })).toHaveAttribute(
      "href",
      "/login?callbackUrl=%2Fprojects"
    );
    expect(screen.queryByRole("heading", { name: /mes projets/i })).not.toBeInTheDocument();
  });

  it("opens the account gate instead of creating a project when signed out", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { ok: false }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<ProjectsPage />);
    await screen.findByRole("region", { name: /mode exploration/i });
    fireEvent.click(screen.getByRole("button", { name: /nouveau projet/i }));

    const dialog = await screen.findByRole("dialog", { name: /compte est nécessaire/i });
    expect(dialog.querySelector("a")).toHaveAttribute("href", "/login?callbackUrl=%2Fprojects");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/projects", expect.objectContaining({ method: "POST" }));
    // The public page stays usable underneath.
    expect(screen.getByRole("link", { name: /podcast · les signaux faibles/i })).toBeInTheDocument();
  });

  it("shows the signed-in user's projects alongside the demo cards", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        projects: [
          { id: "p-1", title: "Mon vrai projet", status: "draft", updatedAt: "2026-01-01T00:00:00.000Z" },
        ],
      })
    ) as unknown as typeof fetch;

    render(<ProjectsPage />);

    expect(await screen.findByRole("link", { name: /mon vrai projet/i })).toHaveAttribute("href", "/projects/p-1");
    expect(screen.getByRole("link", { name: /podcast · les signaux faibles/i })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /mode exploration/i })).not.toBeInTheDocument();
  });

  it("creates a project through the API when signed in", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(201, { ok: true, project: { id: "p-new" } });
      return jsonResponse(200, { ok: true, projects: [] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<ProjectsPage />);
    await screen.findByText(/aucun projet pour le moment/i);
    fireEvent.click(screen.getByRole("button", { name: /nouveau projet/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/p-new"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
