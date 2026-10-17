/**
 * Next.js calls `register()` once per server instance, before it starts
 * handling requests (see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
 * That is the only hook in the framework able to start a background loop
 * that outlives a single request, so it is where the in-server job worker
 * is started in development.
 *
 * It must stay cheap and must never throw: a rejected `register()` would
 * take the whole server's startup with it. startInlineWorker() therefore
 * handles its own failures and returns instead of propagating.
 */
export async function register() {
  // Called in every runtime, and the worker's dependencies (node:sqlite,
  // child processes for yt-dlp/ffmpeg) exist only in Node.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startInlineWorker } = await import("@/lib/jobs/inlineWorker");
  startInlineWorker();
}
