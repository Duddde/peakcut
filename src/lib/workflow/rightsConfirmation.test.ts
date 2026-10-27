import { describe, expect, it } from "vitest";
import { isRightsConfirmationRequired } from "./rightsConfirmation";

describe("isRightsConfirmationRequired", () => {
  it("is off under next dev only", () => {
    expect(isRightsConfirmationRequired({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("stays on in production, in tests and when NODE_ENV is unset (standalone worker)", () => {
    expect(isRightsConfirmationRequired({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRightsConfirmationRequired({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isRightsConfirmationRequired({} as NodeJS.ProcessEnv)).toBe(true);
  });
});
