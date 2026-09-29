import { describe, expect, it } from "vitest";
import {
  authorizeExport,
  canExport,
  confirmRights,
  createInitialWorkflow,
  ExportNotAuthorizedError,
  RightsNotConfirmedError,
} from "./workflow";
import { PUBLICATION_POLICY } from "@/lib/domain/types";

describe("createInitialWorkflow", () => {
  it("starts in analysis_preview with unconfirmed rights", () => {
    const workflow = createInitialWorkflow();
    expect(workflow.phase).toBe("analysis_preview");
    expect(workflow.rights.confirmed).toBe(false);
    expect(workflow.rights.confirmedAt).toBeNull();
    expect(workflow.rights.confirmedBy).toBeNull();
  });

  it("always carries the publication_never_implicit policy", () => {
    const workflow = createInitialWorkflow();
    expect(workflow.publicationPolicy).toBe(PUBLICATION_POLICY);
    expect(workflow.publicationPolicy).toBe("publication_never_implicit");
  });
});

describe("confirmRights", () => {
  it("marks rights as confirmed with a timestamp and identifier, without changing phase", () => {
    const workflow = createInitialWorkflow();
    const confirmed = confirmRights(workflow, "editeur-demo@example.com");
    expect(confirmed.rights.confirmed).toBe(true);
    expect(confirmed.rights.confirmedBy).toBe("editeur-demo@example.com");
    expect(confirmed.rights.confirmedAt).not.toBeNull();
    expect(confirmed.phase).toBe("analysis_preview");
  });

  it("rejects an empty confirmedBy identifier", () => {
    const workflow = createInitialWorkflow();
    expect(() => confirmRights(workflow, "")).toThrow();
    expect(() => confirmRights(workflow, "   ")).toThrow();
  });

  it("does not mutate the input workflow", () => {
    const workflow = createInitialWorkflow();
    confirmRights(workflow, "someone");
    expect(workflow.rights.confirmed).toBe(false);
  });
});

describe("authorizeExport", () => {
  it("throws RightsNotConfirmedError when rights are not confirmed", () => {
    const workflow = createInitialWorkflow();
    expect(() => authorizeExport(workflow)).toThrow(RightsNotConfirmedError);
  });

  it("transitions to export_authorized once rights are confirmed", () => {
    const workflow = confirmRights(createInitialWorkflow(), "someone");
    const authorized = authorizeExport(workflow);
    expect(authorized.phase).toBe("export_authorized");
  });

  it("never changes the publication policy, even once export is authorized", () => {
    const workflow = authorizeExport(confirmRights(createInitialWorkflow(), "someone"));
    expect(workflow.publicationPolicy).toBe("publication_never_implicit");
  });

  it("does not mutate the input workflow", () => {
    const workflow = confirmRights(createInitialWorkflow(), "someone");
    authorizeExport(workflow);
    expect(workflow.phase).toBe("analysis_preview");
  });
});

describe("canExport", () => {
  it("is false for a fresh workflow", () => {
    expect(canExport(createInitialWorkflow())).toBe(false);
  });

  it("is false once rights are confirmed but export not yet authorized", () => {
    const workflow = confirmRights(createInitialWorkflow(), "someone");
    expect(canExport(workflow)).toBe(false);
  });

  it("is true once export has been authorized", () => {
    const workflow = authorizeExport(confirmRights(createInitialWorkflow(), "someone"));
    expect(canExport(workflow)).toBe(true);
  });
});

describe("ExportNotAuthorizedError", () => {
  it("carries a human-readable message referencing the required confirmation", () => {
    const error = new ExportNotAuthorizedError();
    expect(error.message).toMatch(/autoris/i);
  });
});
