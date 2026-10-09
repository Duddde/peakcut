import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AccountGate } from "./AccountGate";

describe("AccountGate", () => {
  it("renders as an accessible modal dialog with a name and a description", () => {
    render(<AccountGate callbackUrl="/foo" onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /compte est nécessaire/i });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/démonstration reste consultable/i);
  });

  it("links to /login with the given callbackUrl, encoded, under a provider-neutral label", () => {
    render(<AccountGate callbackUrl="/projects/abc?x=1" onClose={() => {}} />);
    const link = screen.getByRole("link", { name: /se connecter ou créer un compte/i });
    expect(link).toHaveAttribute("href", `/login?callbackUrl=${encodeURIComponent("/projects/abc?x=1")}`);
    expect(link).not.toHaveTextContent(/google/i);
  });

  it("keeps the #studio hash of the public demo callback", () => {
    render(<AccountGate callbackUrl="/#studio" onClose={() => {}} />);
    expect(screen.getByRole("link", { name: /se connecter/i })).toHaveAttribute(
      "href",
      `/login?callbackUrl=${encodeURIComponent("/#studio")}`
    );
  });

  it("never forwards an absolute or protocol-relative callbackUrl", () => {
    const { rerender } = render(<AccountGate callbackUrl="https://evil.example/x" onClose={() => {}} />);
    expect(screen.getByRole("link", { name: /se connecter/i })).toHaveAttribute("href", "/login?callbackUrl=%2F");
    rerender(<AccountGate callbackUrl="//evil.example" onClose={() => {}} />);
    expect(screen.getByRole("link", { name: /se connecter/i })).toHaveAttribute("href", "/login?callbackUrl=%2F");
  });

  it("moves focus to the sign-in link when opened and restores it when closed", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<AccountGate callbackUrl="/" onClose={() => {}} />);
    expect(screen.getByRole("link", { name: /se connecter/i })).toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<AccountGate callbackUrl="/" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab focus inside the dialog", () => {
    render(<AccountGate callbackUrl="/" onClose={() => {}} />);
    const link = screen.getByRole("link", { name: /se connecter/i });
    const cancel = screen.getByRole("button", { name: /annuler/i });

    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(link).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
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
