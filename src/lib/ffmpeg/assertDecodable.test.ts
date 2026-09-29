import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertDecodable, NotDecodableError } from "./assertDecodable";
import { createSyntheticVideo } from "../../../test/fixtures/createSyntheticVideo";

describe("assertDecodable (real ffmpeg decode pass)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-decodable-"));
  }, 30000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves for a genuinely decodable video file", async () => {
    const filePath = path.join(dir, "ok.mp4");
    await createSyntheticVideo(filePath, 2);
    await expect(assertDecodable(filePath)).resolves.toBeUndefined();
  }, 30000);

  it("rejects with NotDecodableError for a corrupt/non-media file", async () => {
    const filePath = path.join(dir, "corrupt.mp4");
    await writeFile(filePath, "this is not a real video file at all");
    await expect(assertDecodable(filePath)).rejects.toBeInstanceOf(NotDecodableError);
  });

  it("rejects for a nonexistent file", async () => {
    await expect(assertDecodable(path.join(dir, "missing.mp4"))).rejects.toBeInstanceOf(
      NotDecodableError
    );
  });
});
