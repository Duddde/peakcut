import { NextResponse } from "next/server";
import packageJson from "../../../../package.json";

/**
 * Minimal liveness endpoint. Deliberately tiny and secret-free: it only
 * confirms the app process is up and answering requests, nothing about
 * infrastructure, configuration, or credentials.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "peakcut",
    version: packageJson.version,
    checks: { app: true },
  });
}
