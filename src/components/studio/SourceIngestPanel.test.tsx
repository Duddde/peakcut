import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourceIngestPanel } from "./SourceIngestPanel";

function makeFile(name: string, type: string, sizeBytes: number): File {
  const file = new File([new Uint8Array(sizeBytes)], name, { type });
  return file;
}

describe("SourceIngestPanel", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // jsdom does not implement object URLs.
    globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-preview-url");
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("shows no media preview before a file is selected", () => {
    render(<SourceIngestPanel onIngested={vi.fn()} />);
    expect(screen.queryByTestId("media-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /importer/i })).toBeDisabled();
  });

  it("shows filename, size and type metadata once a file is selected, and enables import", async () => {
    render(<SourceIngestPanel onIngested={vi.fn()} />);
    const input = screen.getByLabelText(/choisir un fichier/i);
    const file = makeFile("clip.mp4", "video/mp4", 2 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/clip\.mp4/)).toBeInTheDocument();
    expect(screen.getByText(/video\/mp4/)).toBeInTheDocument();
    expect(screen.getByTestId("media-preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /importer/i })).toBeEnabled();
  });

  it("shows a loading state while the upload request is in flight", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    globalThis.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;

    render(<SourceIngestPanel onIngested={vi.fn()} />);
    const input = screen.getByLabelText(/choisir un fichier/i);
    fireEvent.change(input, { target: { files: [makeFile("clip.mp4", "video/mp4", 1024)] } });
    fireEvent.click(screen.getByRole("button", { name: /importer/i }));

    expect(await screen.findByText(/import en cours/i)).toBeInTheDocument();

    resolveFetch({
      ok: true,
      status: 201,
      json: async () => ({
        ok: true,
        source: {
          id: "s1",
          type: "local-upload",
          title: "clip.mp4",
          localFilePath: "/data/uploads/x.mp4",
          durationSec: 5,
          originTimestamp: "2026-01-01T00:00:00.000Z",
          confidence: 1,
        },
        workflow: {
          phase: "analysis_preview",
          publicationPolicy: "publication_never_implicit",
          rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
        },
      }),
    });

    await waitFor(() => expect(screen.getByText(/import réussi/i)).toBeInTheDocument());
  });

  it("calls onIngested with the parsed source and workflow on success", async () => {
    const onIngested = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        ok: true,
        source: {
          id: "s1",
          type: "local-upload",
          title: "clip.mp4",
          localFilePath: "/data/uploads/x.mp4",
          durationSec: 5,
          originTimestamp: "2026-01-01T00:00:00.000Z",
          confidence: 1,
        },
        workflow: {
          phase: "analysis_preview",
          publicationPolicy: "publication_never_implicit",
          rights: { confirmed: false, confirmedAt: null, confirmedBy: null },
        },
      }),
    }) as unknown as typeof fetch;

    render(<SourceIngestPanel onIngested={onIngested} />);
    fireEvent.change(screen.getByLabelText(/choisir un fichier/i), {
      target: { files: [makeFile("clip.mp4", "video/mp4", 1024)] },
    });
    fireEvent.click(screen.getByRole("button", { name: /importer/i }));

    await waitFor(() => expect(onIngested).toHaveBeenCalledTimes(1));
    expect(onIngested.mock.calls[0][0].source.id).toBe("s1");
    expect(onIngested.mock.calls[0][0].workflow.phase).toBe("analysis_preview");
  });

  it("shows a French error message via an aria-live region when the server rejects the file, without calling onIngested", async () => {
    const onIngested = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ ok: false, error: "Extension non autorisée." }),
    }) as unknown as typeof fetch;

    render(<SourceIngestPanel onIngested={onIngested} />);
    fireEvent.change(screen.getByLabelText(/choisir un fichier/i), {
      target: { files: [makeFile("clip.exe", "video/mp4", 1024)] },
    });
    fireEvent.click(screen.getByRole("button", { name: /importer/i }));

    const alert = await screen.findByRole("status");
    await waitFor(() => expect(alert).toHaveTextContent(/extension non autorisée/i));
    expect(onIngested).not.toHaveBeenCalled();
  });

  it("shows a generic error message when the network request throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    render(<SourceIngestPanel onIngested={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/choisir un fichier/i), {
      target: { files: [makeFile("clip.mp4", "video/mp4", 1024)] },
    });
    fireEvent.click(screen.getByRole("button", { name: /importer/i }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/impossible de contacter/i)
    );
  });
});
