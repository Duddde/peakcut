import { describe, expect, it } from "vitest";
import path from "node:path";
import { assetFilePath, projectAssetsDir } from "./assetPath";

const BASE = path.join(path.resolve(path.sep), "srv", "assets");
const ID = "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c";

describe("assetFilePath", () => {
  it("derives the path from the ids and the type", () => {
    expect(assetFilePath(BASE, "p1", ID, "image/png")).toBe(path.join(BASE, "p1", ID + ".png"));
    expect(assetFilePath(BASE, "p1", ID, "image/jpeg")).toBe(path.join(BASE, "p1", ID + ".jpg"));
  });

  it("refuses an id that is not one, instead of building a path from it", () => {
    expect(assetFilePath(BASE, "p1", "..", "image/png")).toBeNull();
    expect(assetFilePath(BASE, "..", ID, "image/png")).toBeNull();
    expect(assetFilePath(BASE, "a/b", ID, "image/png")).toBeNull();
  });

  it("gives each project its own directory", () => {
    expect(projectAssetsDir(BASE, "p1")).toBe(path.join(BASE, "p1"));
    expect(projectAssetsDir(BASE, "../other")).toBeNull();
  });
});
