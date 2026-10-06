// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { fillSavedLogin } from "./PasswordAutofill.ts";

const login = {
  origin: "https://example.com",
  username: "me@example.com",
  password: "fixture-secret",
  submit: false,
};
const form = () => document.querySelector("form")!;
const password = () => document.querySelector<HTMLInputElement>('input[type="password"]')!;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("location", new URL("https://example.com/login"));
  document.body.innerHTML =
    '<form method="post" action="https://example.com/session"><input type="email"><input type="password" autocomplete="current-password"></form>';
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

describe("saved login autofill", () => {
  it("fills through native setters and dispatches input events", () => {
    const changed = vi.fn();
    password().addEventListener("input", changed);
    expect(fillSavedLogin(login)).toBe("filled");
    expect(password().value).toBe(login.password);
    expect(document.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe(
      login.username,
    );
    expect(changed).toHaveBeenCalledOnce();
  });
  it("clears the password when the page enters browser history", () => {
    expect(fillSavedLogin(login)).toBe("filled");
    window.dispatchEvent(new Event("pagehide"));
    expect(password().value).toBe("");
  });
  it.each(["https://other.example", "https://example.com:8443", "http://example.com"])(
    "refuses mismatched origin %s",
    (origin) => {
      expect(fillSavedLogin({ ...login, origin })).toBe("needs-human");
      expect(password().value).toBe("");
    },
  );
  it("does not fill ambiguous or registration forms", () => {
    password().autocomplete = "section-signup new-password";
    expect(fillSavedLogin(login)).toBe("needs-human");
    password().autocomplete = "";
    form().append(password().cloneNode());
    expect(fillSavedLogin(login)).toBe("needs-human");
    expect(password().value).toBe("");
  });
  it("rechecks the form after username handlers run", () => {
    document.querySelector('input[type="email"]')!.addEventListener("input", () => {
      form().action = "https://other.example";
    });
    expect(fillSavedLogin(login)).toBe("needs-human");
    expect(password().value).toBe("");
  });
  it("submits only a same-origin POST and reports submission, not authentication", () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => {});
    expect(fillSavedLogin({ ...login, submit: true })).toBe("submitted");
    expect(submit).toHaveBeenCalledOnce();
    for (const method of ["get", "dialog"]) {
      form().method = method;
      expect(fillSavedLogin({ ...login, submit: true })).toBe("needs-human");
    }
    expect(submit).toHaveBeenCalledOnce();
  });
  it("requires human help for cross-origin submission and does not expose a secret in the result", () => {
    form().action = "https://other.example";
    expect(fillSavedLogin(login)).toBe("needs-human");
    expect(password().value).toBe("");
  });
});
