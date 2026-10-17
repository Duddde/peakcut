import { afterEach, describe, expect, it } from "vitest";
import { defaultImageProviderId, getImageProvider, listImageProviders } from "./registry";
import { isImageProviderConfigured } from "./providerConfiguration";

describe("image provider registry", () => {
  it("offers only providers that can actually generate an image", () => {
    const ids = listImageProviders().map((p) => p.id);
    expect(ids).toContain("openai-gpt-image-1");
    expect(ids.some((id) => /mock|fake|demo/i.test(id))).toBe(false);
  });

  it("gives every provider a display name", () => {
    for (const provider of listImageProviders()) {
      expect(provider.displayName.length).toBeGreaterThan(0);
    }
  });

  it("refuses an unknown id", () => {
    expect(() => getImageProvider("inconnu")).toThrow(/inconnu/);
  });

  it("names a default provider that is actually in the registry", () => {
    expect(listImageProviders().map((p) => p.id)).toContain(defaultImageProviderId());
  });
});

describe("isImageProviderConfigured", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it("follows the presence of the key, without revealing it", () => {
    process.env.OPENAI_API_KEY = "cle";
    expect(isImageProviderConfigured("openai-gpt-image-1")).toBe(true);
    delete process.env.OPENAI_API_KEY;
    expect(isImageProviderConfigured("openai-gpt-image-1")).toBe(false);
  });

  it("reports an unknown provider as not configured", () => {
    expect(isImageProviderConfigured("inconnu")).toBe(false);
  });
});
