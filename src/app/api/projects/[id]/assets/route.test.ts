// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createProjectAssetUploadHandler, createProjectAssetsListHandler } from "./route";
import { createProjectAssetDeleteHandler, createProjectAssetFileHandler } from "./[assetId]/route";
import { createGenerateProjectAssetHandler } from "./generate/route";
import { createProjectsCreateHandler } from "../../route";
import { createTestAppDeps } from "../../../../../../test/helpers/testAppDeps";
import { SqliteUserRepository } from "@/lib/auth/UserRepository";
import { SqliteSessionRepository } from "@/lib/auth/SessionRepository";
import { SESSION_COOKIE_NAME, signSessionId } from "@/lib/auth/sessionCookie";
import type { AppDeps } from "@/lib/appDeps";
import type { ImageProvider } from "@/lib/images/ImageProvider";
import { ImageProviderNotConfiguredError } from "@/lib/images/ImageProvider";
import { createFixedWindowRateLimiter } from "@/lib/ratelimit/fixedWindowRateLimiter";

const PNG_BYTES = (() => {
  const data = Buffer.alloc(256);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  return data;
})();

const tempDirs: string[] = [];

async function assetsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "peakcut-assets-route-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function authed(deps: AppDeps, email: string) {
  const user = new SqliteUserRepository(deps.db).createUser(email, "hash");
  const session = new SqliteSessionRepository(deps.db).createSession(
    user.id,
    new Date(Date.now() + 60_000).toISOString()
  );
  return { user, cookie: signSessionId(session.id, deps.authSecret) };
}

function request(url: string, cookie?: string, init: RequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookie}`);
  return new NextRequest(url, { ...init, signal: undefined, headers });
}

async function createProject(deps: AppDeps, cookie: string) {
  const POST = createProjectsCreateHandler(deps);
  const res = await POST(
    request("http://localhost/api/projects", cookie, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Projet" }),
    })
  );
  return (await res.json()).project as { id: string };
}

function uploadRequest(projectId: string, cookie: string | undefined, data: Buffer, type = "image/png"): NextRequest {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(data)], "image.png", { type }));
  return request(`http://localhost/api/projects/${projectId}/assets`, cookie, { method: "POST", body: form });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function assetCtx(id: string, assetId: string) {
  return { params: Promise.resolve({ id, assetId }) };
}

async function uploadOne(deps: AppDeps, baseDir: string, projectId: string, cookie: string) {
  const POST = createProjectAssetUploadHandler({ appDeps: deps, assetsBaseDir: baseDir });
  const res = await POST(uploadRequest(projectId, cookie, PNG_BYTES), ctx(projectId));
  return { status: res.status, body: await res.json() };
}

describe("POST /api/projects/[id]/assets", () => {
  it("stores an uploaded illustration and returns its metadata and URL", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const { status, body } = await uploadOne(deps, baseDir, project.id, cookie);
    expect(status).toBe(201);
    expect(body.asset).toMatchObject({ mimeType: "image/png", sizeBytes: 256, origin: "upload" });
    expect(body.asset.url).toBe(`/api/projects/${project.id}/assets/${body.asset.id}`);
  });

  it("never exposes where the bytes live on the server", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const { body } = await uploadOne(deps, baseDir, project.id, cookie);
    expect(JSON.stringify(body)).not.toContain(baseDir);
  });

  it("refuses a file that is not an image", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const POST = createProjectAssetUploadHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await POST(
      uploadRequest(project.id, cookie, Buffer.alloc(256, 0x41), "image/png"),
      ctx(project.id)
    );
    expect(res.status).toBe(422);
  });

  it("requires authentication", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const POST = createProjectAssetUploadHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await POST(uploadRequest("p1", undefined, PNG_BYTES), ctx("p1"));
    expect(res.status).toBe(401);
  });

  it("answers 404, not 403, for a project belonging to someone else", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const alice = authed(deps, "alice@example.com");
    const bob = authed(deps, "bob@example.com");
    const project = await createProject(deps, alice.cookie);

    const POST = createProjectAssetUploadHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await POST(uploadRequest(project.id, bob.cookie, PNG_BYTES), ctx(project.id));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/projects/[id]/assets", () => {
  it("lists the illustrations of the project", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);
    await uploadOne(deps, baseDir, project.id, cookie);

    const GET = createProjectAssetsListHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await GET(request(`http://localhost/api/projects/${project.id}/assets`, cookie), ctx(project.id));
    expect(res.status).toBe(200);
    expect((await res.json()).assets).toHaveLength(1);
  });

  it("does not list the illustrations of another project", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const alice = authed(deps, "alice@example.com");
    const bob = authed(deps, "bob@example.com");
    const aliceProject = await createProject(deps, alice.cookie);
    await uploadOne(deps, baseDir, aliceProject.id, alice.cookie);
    const bobProject = await createProject(deps, bob.cookie);

    const GET = createProjectAssetsListHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await GET(
      request(`http://localhost/api/projects/${bobProject.id}/assets`, bob.cookie),
      ctx(bobProject.id)
    );
    expect((await res.json()).assets).toEqual([]);
  });
});

describe("GET /api/projects/[id]/assets/[assetId]", () => {
  it("serves the bytes to the owner", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);
    const { body } = await uploadOne(deps, baseDir, project.id, cookie);

    const GET = createProjectAssetFileHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await GET(
      request(`http://localhost/api/projects/${project.id}/assets/${body.asset.id}`, cookie),
      assetCtx(project.id, body.asset.id)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("will not serve an illustration of one project through another", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const alice = authed(deps, "alice@example.com");
    const bob = authed(deps, "bob@example.com");
    const aliceProject = await createProject(deps, alice.cookie);
    const { body } = await uploadOne(deps, baseDir, aliceProject.id, alice.cookie);
    const bobProject = await createProject(deps, bob.cookie);

    const GET = createProjectAssetFileHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await GET(
      request(`http://localhost/api/projects/${bobProject.id}/assets/${body.asset.id}`, bob.cookie),
      assetCtx(bobProject.id, body.asset.id)
    );
    expect(res.status).toBe(404);
  });

  it("refuses an asset id that is not an id, without looking anything up", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const GET = createProjectAssetFileHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await GET(
      request(`http://localhost/api/projects/${project.id}/assets/x`, cookie),
      assetCtx(project.id, "../../etc/passwd")
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/projects/[id]/assets/[assetId]", () => {
  it("removes the illustration", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);
    const { body } = await uploadOne(deps, baseDir, project.id, cookie);

    const DELETE = createProjectAssetDeleteHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await DELETE(
      request(`http://localhost/api/projects/${project.id}/assets/${body.asset.id}`, cookie, {
        method: "DELETE",
      }),
      assetCtx(project.id, body.asset.id)
    );
    expect(res.status).toBe(200);

    const GET = createProjectAssetsListHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const list = await GET(request(`http://localhost/api/projects/${project.id}/assets`, cookie), ctx(project.id));
    expect((await list.json()).assets).toEqual([]);
  });

  it("answers 404 for an illustration that is not there", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const DELETE = createProjectAssetDeleteHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const res = await DELETE(
      request(`http://localhost/api/projects/${project.id}/assets/x`, cookie, { method: "DELETE" }),
      assetCtx(project.id, "1f3b8c2a-5d4e-4f6a-9b1c-2e3d4f5a6b7c")
    );
    expect(res.status).toBe(404);
  });
});

function generateRequest(projectId: string, cookie: string | undefined, body: unknown): NextRequest {
  return request(`http://localhost/api/projects/${projectId}/assets/generate`, cookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeProvider(data = PNG_BYTES): ImageProvider {
  return {
    id: "openai-gpt-image-1",
    displayName: "Fournisseur de test",
    generate: vi.fn(async (req) => ({
      data,
      mimeType: "image/png",
      providerId: "openai-gpt-image-1",
      prompt: req.prompt,
    })),
  };
}

describe("POST /api/projects/[id]/assets/generate", () => {
  it("stores the generated image with the prompt that produced it", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const POST = createGenerateProjectAssetHandler({
      appDeps: deps,
      assetsBaseDir: baseDir,
      providerFor: () => fakeProvider(),
    });
    const res = await POST(
      generateRequest(project.id, cookie, { prompt: "un graphique qui monte" }),
      ctx(project.id)
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.asset).toMatchObject({
      origin: "generated",
      prompt: "un graphique qui monte",
      providerId: "openai-gpt-image-1",
    });
  });

  it("refuses an empty prompt", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const POST = createGenerateProjectAssetHandler({
      appDeps: deps,
      assetsBaseDir: baseDir,
      providerFor: () => fakeProvider(),
    });
    const res = await POST(generateRequest(project.id, cookie, { prompt: " " }), ctx(project.id));
    expect(res.status).toBe(422);
  });

  it("answers 503 when the generator is not configured, never a placeholder image", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const POST = createGenerateProjectAssetHandler({
      appDeps: deps,
      assetsBaseDir: baseDir,
      providerFor: () => ({
        id: "openai-gpt-image-1",
        displayName: "Non configure",
        generate: async () => {
          throw new ImageProviderNotConfiguredError("openai-gpt-image-1", "OPENAI_API_KEY");
        },
      }),
    });
    const res = await POST(generateRequest(project.id, cookie, { prompt: "une carte" }), ctx(project.id));
    expect(res.status).toBe(503);

    const GET = createProjectAssetsListHandler({ appDeps: deps, assetsBaseDir: baseDir });
    const list = await GET(request(`http://localhost/api/projects/${project.id}/assets`, cookie), ctx(project.id));
    expect((await list.json()).assets).toEqual([]);
  });

  it("refuses bytes from a provider that are not an image", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const POST = createGenerateProjectAssetHandler({
      appDeps: deps,
      assetsBaseDir: baseDir,
      providerFor: () => fakeProvider(Buffer.alloc(256, 0x41)),
    });
    const res = await POST(generateRequest(project.id, cookie, { prompt: "une carte" }), ctx(project.id));
    expect(res.status).toBe(502);
  });

  it("stops a runaway client at the per-account limit", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const { cookie } = authed(deps, "alice@example.com");
    const project = await createProject(deps, cookie);

    const POST = createGenerateProjectAssetHandler({
      appDeps: deps,
      assetsBaseDir: baseDir,
      providerFor: () => fakeProvider(),
      rateLimiter: createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });

    const first = await POST(generateRequest(project.id, cookie, { prompt: "une carte" }), ctx(project.id));
    expect(first.status).toBe(201);
    const second = await POST(generateRequest(project.id, cookie, { prompt: "une carte" }), ctx(project.id));
    expect(second.status).toBe(429);
  });

  it("answers 404 for a project belonging to someone else", async () => {
    const deps = createTestAppDeps();
    const baseDir = await assetsDir();
    const alice = authed(deps, "alice@example.com");
    const bob = authed(deps, "bob@example.com");
    const project = await createProject(deps, alice.cookie);

    const POST = createGenerateProjectAssetHandler({
      appDeps: deps,
      assetsBaseDir: baseDir,
      providerFor: () => fakeProvider(),
    });
    const res = await POST(generateRequest(project.id, bob.cookie, { prompt: "une carte" }), ctx(project.id));
    expect(res.status).toBe(404);
  });
});
