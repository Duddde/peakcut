import { describe, expect, it } from "vitest";
import { MockTranscriptProvider } from "./MockTranscriptProvider";

describe("MockTranscriptProvider", () => {
  it("has a stable id and display name", () => {
    const provider = new MockTranscriptProvider();
    expect(provider.id).toBe("mock-deterministic");
    expect(provider.displayName).toBeTruthy();
  });

  it("returns a deterministic transcript for the same input", async () => {
    const provider = new MockTranscriptProvider();
    const a = await provider.transcribe({ mediaPath: "/tmp/demo.mp4" });
    const b = await provider.transcribe({ mediaPath: "/tmp/demo.mp4" });
    expect(a).toEqual(b);
  });

  it("stamps the transcript with its own provider id", async () => {
    const provider = new MockTranscriptProvider();
    const transcript = await provider.transcribe({ mediaPath: "/tmp/demo.mp4" });
    expect(transcript.providerId).toBe("mock-deterministic");
  });

  it("produces a non-empty, word-by-word transcript with monotonic timing", async () => {
    const provider = new MockTranscriptProvider();
    const transcript = await provider.transcribe({ mediaPath: "/tmp/demo.mp4" });
    expect(transcript.words.length).toBeGreaterThan(10);
    for (let i = 1; i < transcript.words.length; i++) {
      expect(transcript.words[i].startSec).toBeGreaterThanOrEqual(
        transcript.words[i - 1].startSec
      );
      expect(transcript.words[i].endSec).toBeGreaterThanOrEqual(transcript.words[i].startSec);
    }
  });

  it("reports a confidence between 0 and 1 for every word", async () => {
    const provider = new MockTranscriptProvider();
    const transcript = await provider.transcribe({ mediaPath: "/tmp/demo.mp4" });
    for (const word of transcript.words) {
      expect(word.confidence).toBeGreaterThanOrEqual(0);
      expect(word.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("includes at least two distinct speakers to demonstrate diarization", async () => {
    const provider = new MockTranscriptProvider();
    const transcript = await provider.transcribe({ mediaPath: "/tmp/demo.mp4" });
    const speakers = new Set(transcript.words.map((w) => w.speaker));
    expect(speakers.size).toBeGreaterThanOrEqual(2);
  });

  it("never performs network I/O", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      throw new Error("fetch should not be called by the mock provider");
    };
    try {
      const provider = new MockTranscriptProvider();
      await provider.transcribe({ mediaPath: "/tmp/demo.mp4" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(called).toBe(false);
  });

  it("does not require any environment variable or API key", async () => {
    const provider = new MockTranscriptProvider();
    await expect(provider.transcribe({ mediaPath: "/tmp/demo.mp4" })).resolves.toBeDefined();
  });
});
