import type { BrowserSignInResult } from "@t3tools/contracts";

/** Runs in an isolated world. Keep all helpers inside this function. */
export function fillSavedLogin(input: {
  origin: string;
  username: string;
  password: string;
  submit: boolean;
}): BrowserSignInResult["status"] {
  if (location.origin !== input.origin || location.protocol !== "https:") return "needs-human";
  const visible = (element: HTMLInputElement) => {
    const style = getComputedStyle(element);
    return (
      !element.disabled &&
      !element.readOnly &&
      element.getClientRects().length > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };
  const passwords = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ).filter(visible);
  if (passwords.length !== 1) return "needs-human";
  const password = passwords[0]!;
  if (password.autocomplete.split(/\s+/).includes("new-password")) return "needs-human";
  const form = password.form;
  if (!form || new URL(form.action || location.href).origin !== input.origin) return "needs-human";
  const candidates = Array.from(form.querySelectorAll<HTMLInputElement>("input")).filter(
    (element) => visible(element) && ["text", "email"].includes(element.type),
  );
  const usernames = candidates.filter(
    (element) => element.autocomplete === "username" || element.type === "email",
  );
  const username =
    usernames.length === 1 ? usernames[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (candidates.length > 0 && !username) return "needs-human";
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const fill = (element: HTMLInputElement, value: string) => {
    setValue.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (username) fill(username, input.username);
  // Input handlers may change the document or the form. Recheck before giving it the secret.
  if (
    !password.isConnected ||
    password.form !== form ||
    location.origin !== input.origin ||
    new URL(form.action || location.href).origin !== input.origin
  )
    return "needs-human";
  // A cached history entry must not bring the filled password back to page tools.
  window.addEventListener("pagehide", () => fill(password, ""), { once: true });
  fill(password, input.password);
  if (!input.submit) return "filled";
  // Never put a saved password in a GET URL or submit a changed/cross-origin form.
  if (
    location.origin !== input.origin ||
    !form.isConnected ||
    !password.isConnected ||
    password.form !== form ||
    new URL(form.action || location.href).origin !== input.origin ||
    form.method.toLowerCase() !== "post" ||
    (form.target && form.target !== "_self") ||
    !form.checkValidity()
  )
    return "needs-human";
  HTMLFormElement.prototype.requestSubmit.call(form);
  return "submitted";
}
