// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createWaveformHandler } from "./route";
import { createTestAppDeps } from "../../../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import { SqliteProjectRepository } from "@/lib/db/ProjectRepository";
import { createInitialWorkflow } from "@/lib/workflow/workflow";
import type { AppDeps } from "@/lib/appDeps";
import type { ReadAudioEnvelope } from "@/lib/ffmpeg/audioEnvelope";

function signIn(deps: AppDeps, email: string) {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(user.id, new Date(Date.now() + 60_000).toISOString());
  return { user, cookie: signSessionId(session.id, deps.authSecret) };
}

function get(query: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost/api/projects/p1/waveform?${query}`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {},
  });
}

const context = { params: Promise.resolve({ id: "p1" }) };

describe("GET /api/projects/[id]/waveform", () => {
  let dir: string;
  let mediaPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "peakcut-waveform-"));
    mediaPath = path.join(dir, "source.mp4");
    await writeFile(mediaPath, "media");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup() {
    const deps = createTestAppDeps();
    const { user, cookie } = signIn(deps, "alice@example.com");
    const now = new Date().toISOString();
    new SqliteProjectRepository(deps.db).createProject(user.id, {
      id: "p1",
      title: "P",
      createdAt: now,
      updatedAt: now,
      status: "draft",
      source: { id: "s", type: "local-upload", title: "S", localFilePath: mediaPath, durationSec: 120, originTimestamp: now, confidence: 1 },
      transcript: null,
      segments: [],
      timeline: null,
      workflow: createInitialWorkflow(),
    });
    return { deps, cookie };
  }

  it("returns the window's levels, normalized to its loudest moment, from the project's own media", async () => {
    const { deps, cookie } = setup();
    const read = vi.fn<ReadAudioEnvelope>(async (_path, startSec, _duration, frameSec) => ({
      startSec,
      frameSec,
      levels: [0.1, 0.2, 0.05],
    }));
    const res = await createWaveformHandler(deps, read)(get("startSec=10&endSec=20&points=3", cookie), context);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, startSec: 10, levels: [0.5, 1, 0.25] });
    expect(read).toHaveBeenCalledWith(mediaPath, 10, 10, expect.closeTo(10 / 3, 5));
  });

  it("refuses an oversized or inverted window", async () => {
    const { deps, cookie } = setup();
    const handler = createWaveformHandler(deps, vi.fn());
    expect((await handler(get("startSec=0&endSec=400", cookie), context)).status).toBe(400);
    expect((await handler(get("startSec=20&endSec=10", cookie), context)).status).toBe(400);
  });

  it("hides another account's project", async () => {
    const { deps } = setup();
    const { cookie: other } = signIn(deps, "bob@example.com");
    const res = await createWaveformHandler(deps, vi.fn())(get("startSec=0&endSec=10", other), context);
    expect(res.status).toBe(404);
  });
});
