import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Segment } from "@/lib/domain/types";
import { buildRenderPlan } from "@/lib/effects/buildRenderPlan";
import { validateRenderPlan } from "@/lib/effects/validateRenderPlan";
import { MAX_OVERLAYS_PER_PLAN, type RenderPlan } from "@/lib/effects/types";
import { defaultOverlayFor } from "@/lib/effects/overlayEdits";
import { IllustrationsPanel } from "./IllustrationsPanel";

const ASSET_ID = "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c";
const OTHER_ASSET_ID = "2a4c9d3b-6e5f-4a7b-8c2d-3f4e5a6b7c8d";

function asset(id = ASSET_ID, patch: Record<string, unknown> = {}) {
  return {
    id,
    mimeType: "image/png",
    sizeBytes: 1024,
    origin: "upload",
    prompt: null,
    providerId: null,
    createdAt: new Date().toISOString(),
    url: `/api/projects/p1/assets/${id}`,
    ...patch,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function segment(renderPlan: RenderPlan | null = null): Segment {
  return {
    id: "seg-1",
    projectId: "p1",
    title: "Clip",
    startSec: 10,
    endSec: 70,
    words: [],
    score: null,
    safeZones: [],
    variants: [],
    renderPlan,
  };
}

function planWithOneOverlay(): RenderPlan {
  const base = buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 60 });
  return {
    ...base,
    overlays: [defaultOverlayFor({ assetId: ASSET_ID, id: "ov-1", durationSec: 60 })],
  };
}

function fetchReturning(assets: unknown[]) {
  return vi.fn(async () => jsonResponse({ ok: true, assets }));
}

describe("IllustrationsPanel", () => {
  it("lists the images of the project", async () => {
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={() => {}}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    expect(await screen.findByText(/Importée/)).toBeInTheDocument();
    expect(screen.getByText(/Images du projet \(1\)/)).toBeInTheDocument();
  });

  it("shows the prompt of a generated image, which is what identifies it", async () => {
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={() => {}}
        fetchImpl={
          fetchReturning([
            asset(ASSET_ID, { origin: "generated", prompt: "un graphique qui monte" }),
          ]) as unknown as typeof fetch
        }
      />
    );

    expect(await screen.findByText("un graphique qui monte")).toBeInTheDocument();
  });

  it("reports a load failure instead of showing an empty list", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: "Projet introuvable." }, 404));
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Projet introuvable.");
  });

  it("adds an image to a clip that has no plan yet, creating one", async () => {
    const onChange = vi.fn();
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={onChange}
        newId={() => "ov-new"}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /ajouter au clip/i }));

    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.overlays).toHaveLength(1);
    expect(plan.overlays[0]).toMatchObject({ id: "ov-new", assetId: ASSET_ID });
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("keeps the clip's existing effects when adding an image", async () => {
    const onChange = vi.fn();
    const existing = buildRenderPlan("hook-emphasis", { segmentId: "seg-1", segmentDurationSec: 60 });
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(existing)}
        onChange={onChange}
        newId={() => "ov-new"}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /ajouter au clip/i }));
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.templateId).toBe("hook-emphasis");
    expect(plan.zoomKeyframes).toEqual(existing.zoomKeyframes);
  });

  it("refuses to go past the illustration cap, and says why", async () => {
    const full = {
      ...buildRenderPlan("subtle-punch", { segmentId: "seg-1", segmentDurationSec: 60 }),
      overlays: Array.from({ length: MAX_OVERLAYS_PER_PLAN }, (_, i) =>
        defaultOverlayFor({ assetId: ASSET_ID, id: `ov-${i}`, durationSec: 60, index: i })
      ),
    };
    const onChange = vi.fn();
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(full)}
        onChange={onChange}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /ajouter au clip/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(String(MAX_OVERLAYS_PER_PLAN));
  });

  it("lists the illustrations of the clip with their controls", async () => {
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        onChange={() => {}}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    expect(await screen.findByText(/Sur ce clip \(1\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Début de l'illustration ov-1/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Position de l'illustration ov-1/)).toBeInTheDocument();
  });

  it("moves an illustration in time", async () => {
    const onChange = vi.fn();
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        onChange={onChange}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.change(await screen.findByLabelText(/Début de l'illustration ov-1/), {
      target: { value: "30" },
    });
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.overlays[0].startSec).toBe(30);
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("never lets a time field produce a plan the server would refuse", async () => {
    const onChange = vi.fn();
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        onChange={onChange}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.change(await screen.findByLabelText(/Fin de l'illustration ov-1/), {
      target: { value: "9999" },
    });
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.overlays[0].endSec).toBeLessThanOrEqual(60);
    expect(validateRenderPlan(plan).ok).toBe(true);
  });

  it("changes where an illustration sits", async () => {
    const onChange = vi.fn();
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        onChange={onChange}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.change(await screen.findByLabelText(/Position de l'illustration ov-1/), {
      target: { value: "full" },
    });
    const plan = onChange.mock.calls[0][0] as RenderPlan;
    expect(plan.overlays[0].rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("removes an illustration from the clip", async () => {
    const onChange = vi.fn();
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        onChange={onChange}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Retirer l'illustration ov-1/ }));
    expect((onChange.mock.calls[0][0] as RenderPlan).overlays).toEqual([]);
  });

  it("warns when a clip refers to an image the project no longer has", async () => {
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        onChange={() => {}}
        fetchImpl={fetchReturning([asset(OTHER_ASSET_ID)]) as unknown as typeof fetch}
      />
    );

    expect(await screen.findByText(/n'est plus dans le projet/)).toBeInTheDocument();
  });

  it("generates an image from a prompt and offers it", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({
          ok: true,
          asset: asset(ASSET_ID, { origin: "generated", prompt: "une carte ancienne" }),
        });
      }
      return jsonResponse({ ok: true, assets: [] });
    });

    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );

    fireEvent.change(await screen.findByLabelText(/Décrire l'image/), {
      target: { value: "une carte ancienne" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Générer" }));

    expect(await screen.findByText("une carte ancienne")).toBeInTheDocument();
    const generateCall = fetchImpl.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(generateCall![0])).toBe("/api/projects/p1/assets/generate");
    expect(JSON.parse(String(generateCall![1]!.body))).toMatchObject({
      prompt: "une carte ancienne",
      aspect: "portrait",
    });
  });

  it("shows the server's own reason when a generation fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ ok: false, error: "Quota du fournisseur dépassé." }, 502);
      }
      return jsonResponse({ ok: true, assets: [] });
    });

    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );

    fireEvent.change(await screen.findByLabelText(/Décrire l'image/), {
      target: { value: "une carte ancienne" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Générer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Quota du fournisseur dépassé.");
  });

  it("will not offer generation when the server cannot do it", async () => {
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={() => {}}
        generationAvailable={false}
        fetchImpl={fetchReturning([]) as unknown as typeof fetch}
      />
    );

    expect(await screen.findByText(/demande un compte et un fournisseur configuré/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Générer" })).toBeDisabled();
  });

  it("will not offer generation when no generator is configured on the server", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/api/image-providers")
        ? jsonResponse({ ok: true, providers: [{ id: "openai-gpt-image-1", configured: false }] })
        : jsonResponse({ ok: true, assets: [] })
    );

    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment()}
        onChange={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Générer" })).toBeDisabled());
  });

  it("deletes an image from the project and from the clip at once", async () => {
    const onChange = vi.fn();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return jsonResponse({ ok: true, deleted: ASSET_ID });
      return jsonResponse({ ok: true, assets: [asset()] });
    });

    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        onChange={onChange}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Supprimer l'image/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect((onChange.mock.calls[0][0] as RenderPlan).overlays).toEqual([]);
    await waitFor(() => expect(screen.getByText(/Images du projet \(0\)/)).toBeInTheDocument());
  });

  it("changes nothing when read-only, and says so to the caller", async () => {
    const onChange = vi.fn();
    const onReadOnlyAttempt = vi.fn();
    render(
      <IllustrationsPanel
        projectId="p1"
        segment={segment(planWithOneOverlay())}
        readOnly
        onChange={onChange}
        onReadOnlyAttempt={onReadOnlyAttempt}
        fetchImpl={fetchReturning([asset()]) as unknown as typeof fetch}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: /ajouter au clip/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(onReadOnlyAttempt).toHaveBeenCalled();
  });
});
