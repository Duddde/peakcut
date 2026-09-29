import { describe, expect, it } from "vitest";
import {
  parseProviderListResponse,
  ProviderListResponseParseError,
} from "./parseProviderListResponse";

function valid() {
  return {
    ok: true,
    providers: [
      { id: "mock-deterministic", display_name: "Démo déterministe", configured: true },
      { id: "openai-gpt-4o-transcribe-diarize", display_name: "OpenAI", configured: false },
    ],
  };
}

describe("parseProviderListResponse", () => {
  it("parses a well-formed provider list", () => {
    const providers = parseProviderListResponse(valid());
    expect(providers).toEqual([
      { id: "mock-deterministic", displayName: "Démo déterministe", configured: true },
      { id: "openai-gpt-4o-transcribe-diarize", displayName: "OpenAI", configured: false },
    ]);
  });

  it("throws when ok is not true", () => {
    expect(() => parseProviderListResponse({ ok: false })).toThrow(ProviderListResponseParseError);
  });

  it("throws when providers is not an array", () => {
    expect(() => parseProviderListResponse({ ok: true, providers: "nope" })).toThrow(
      ProviderListResponseParseError
    );
  });

  it("throws when a provider entry is missing a required field", () => {
    const payload = valid();
    // @ts-expect-error intentionally malformed
    delete payload.providers[0].configured;
    expect(() => parseProviderListResponse(payload)).toThrow(ProviderListResponseParseError);
  });

  it("throws for a non-object payload", () => {
    expect(() => parseProviderListResponse(null)).toThrow(ProviderListResponseParseError);
  });

  it("returns an empty array for an empty providers list", () => {
    expect(parseProviderListResponse({ ok: true, providers: [] })).toEqual([]);
  });
});
