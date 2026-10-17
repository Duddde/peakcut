import { describe, expect, it } from "vitest";
import {
  GenerateImageRequestError,
  MAX_PROMPT_LENGTH,
  parseGenerateImageRequest,
} from "./parseGenerateImageRequest";

describe("parseGenerateImageRequest", () => {
  it("accepts a prompt and defaults to a vertical image", () => {
    expect(parseGenerateImageRequest({ prompt: "un graphique qui monte" })).toEqual({
      prompt: "un graphique qui monte",
      aspect: "portrait",
      providerId: undefined,
    });
  });

  it("keeps the aspect and the provider when given", () => {
    expect(
      parseGenerateImageRequest({ prompt: "une carte", aspect: "square", providerId: "openai-gpt-image-1" })
    ).toEqual({ prompt: "une carte", aspect: "square", providerId: "openai-gpt-image-1" });
  });

  it("strips control characters from the prompt it will send", () => {
    const parsed = parseGenerateImageRequest({ prompt: "une\u0000carte\u001fancienne" });
    expect(parsed.prompt).toBe("une carte ancienne");
  });

  it("refuses an empty or near-empty prompt", () => {
    expect(() => parseGenerateImageRequest({ prompt: "  " })).toThrow(GenerateImageRequestError);
    expect(() => parseGenerateImageRequest({ prompt: "ab" })).toThrow(GenerateImageRequestError);
  });

  it("refuses a prompt longer than the cap", () => {
    expect(() => parseGenerateImageRequest({ prompt: "a".repeat(MAX_PROMPT_LENGTH + 1) })).toThrow(
      GenerateImageRequestError
    );
  });

  it("refuses an unknown aspect", () => {
    expect(() => parseGenerateImageRequest({ prompt: "une carte", aspect: "cinemascope" })).toThrow(
      GenerateImageRequestError
    );
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseGenerateImageRequest("un graphique")).toThrow(GenerateImageRequestError);
    expect(() => parseGenerateImageRequest(null)).toThrow(GenerateImageRequestError);
  });
});
