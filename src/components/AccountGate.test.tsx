import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountGate } from "./AccountGate";

describe("AccountGate", () => {
  it("renders as an accessible modal dialog", () => {
    render(<AccountGate callbackUrl="/foo" onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /compte est nécessaire/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("links to /login with the given callbackUrl, encoded", () => {
    render(<AccountGate callbackUrl="/projects/abc?x=1" onClose={() => {}} />);
    const link = screen.getByRole("link", { name: /se connecter avec google/i });
    expect(link).toHaveAttribute("href", `/login?callbackUrl=${encodeURIComponent("/projects/abc?x=1")}`);
  });

  it("calls onClose when Annuler is clicked", () => {
    const onClose = vi.fn();
    render(<AccountGate callbackUrl="/" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never mentions a password", () => {
    render(<AccountGate callbackUrl="/" onClose={() => {}} />);
    expect(screen.queryByText(/mot de passe/i)).not.toBeInTheDocument();
  });
});
