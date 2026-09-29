import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DevLoginForm } from "./DevLoginForm";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function fillCredentials(email = "dev@local.test", password = "motdepasse-123") {
  fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/mot de passe/i), { target: { value: password } });
}

describe("DevLoginForm", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalLocation: Location;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "" } as Location,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: originalLocation });
    vi.restoreAllMocks();
  });

  it("keeps both actions disabled until credentials are usable", () => {
    render(<DevLoginForm callbackUrl="/projects" />);
    expect(screen.getByRole("button", { name: /se connecter/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /créer le compte/i })).toBeDisabled();
  });

  it("refuses a password shorter than the signup minimum", () => {
    render(<DevLoginForm callbackUrl="/projects" />);
    fillCredentials("dev@local.test", "court");
    expect(screen.getByRole("button", { name: /se connecter/i })).toBeDisabled();
  });

  it("posts to the existing login route and navigates to the callback URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, user: { id: "u1" } }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<DevLoginForm callbackUrl="/projects/abc" />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /se connecter/i }));

    await waitFor(() => expect(window.location.href).toBe("/projects/abc"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      email: "dev@local.test",
      password: "motdepasse-123",
    });
  });

  it("posts to the signup route for the account-creation action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, user: { id: "u1" } }, 201));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<DevLoginForm callbackUrl="/projects" />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /créer le compte/i }));

    await waitFor(() => expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/signup"));
  });

  it("shows the server's rejection and does not navigate", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ ok: false, error: "Identifiants invalides." }, 401)
    ) as unknown as typeof globalThis.fetch;

    render(<DevLoginForm callbackUrl="/projects" />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /se connecter/i }));

    expect(await screen.findByText(/identifiants invalides/i)).toBeInTheDocument();
    expect(window.location.href).toBe("");
  });

  it("reports a network failure rather than navigating anyway", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;

    render(<DevLoginForm callbackUrl="/projects" />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: /se connecter/i }));

    expect(await screen.findByText(/impossible de contacter le serveur/i)).toBeInTheDocument();
    expect(window.location.href).toBe("");
  });

  it("never renders the password in a readable field", () => {
    render(<DevLoginForm callbackUrl="/projects" />);
    expect(screen.getByLabelText(/mot de passe/i)).toHaveAttribute("type", "password");
  });
});
