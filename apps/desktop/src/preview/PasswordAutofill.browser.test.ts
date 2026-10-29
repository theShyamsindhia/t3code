import { describe, expect, it, vi } from "vite-plus/test";
import { fillSavedLogin } from "./PasswordAutofill.ts";

const login = {
  origin: "https://example.com",
  username: "me@example.com",
  password: "fixture-secret",
  submit: false,
};
// Manager injects the function as source text into the page's isolated world. Rebuild it the
// same way, binding `location` to a signed-in page: the test page's own location cannot change.
const fill = new Function("location", `return (${fillSavedLogin.toString()})`)(
  new URL("https://example.com/login"),
) as typeof fillSavedLogin;
const form = () => document.querySelector("form")!;
const password = () => document.querySelector<HTMLInputElement>('input[type="password"]')!;

function loginPage(): Disposable {
  const page = document.createElement("div");
  page.innerHTML =
    '<form method="post" action="https://example.com/session"><input type="email"><input type="password" autocomplete="current-password"></form>';
  document.body.append(page);
  return { [Symbol.dispose]: () => page.remove() };
}

describe("saved login autofill", () => {
  it("fills through native setters and dispatches input events", () => {
    using _page = loginPage();
    const changed = vi.fn();
    password().addEventListener("input", changed);
    expect(fill(login)).toBe("filled");
    expect(password().value).toBe(login.password);
    expect(document.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe(
      login.username,
    );
    expect(changed).toHaveBeenCalledOnce();
  });
  it("clears the password when the page enters browser history", () => {
    using _page = loginPage();
    expect(fill(login)).toBe("filled");
    window.dispatchEvent(new Event("pagehide"));
    expect(password().value).toBe("");
  });
  it.each(["https://other.example", "https://example.com:8443", "http://example.com"])(
    "refuses mismatched origin %s",
    (origin) => {
      using _page = loginPage();
      expect(fill({ ...login, origin })).toBe("needs-human");
      expect(password().value).toBe("");
    },
  );
  it("does not fill ambiguous or registration forms", () => {
    using _page = loginPage();
    password().autocomplete = "section-signup new-password";
    expect(fill(login)).toBe("needs-human");
    password().autocomplete = "";
    form().append(password().cloneNode());
    expect(fill(login)).toBe("needs-human");
    expect(password().value).toBe("");
  });
  it("rechecks the form after username handlers run", () => {
    using _page = loginPage();
    document.querySelector('input[type="email"]')!.addEventListener("input", () => {
      form().action = "https://other.example";
    });
    expect(fill(login)).toBe("needs-human");
    expect(password().value).toBe("");
  });
  it("submits only a same-origin POST and reports submission, not authentication", () => {
    using _page = loginPage();
    using submit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(() => {});
    expect(fill({ ...login, submit: true })).toBe("submitted");
    expect(submit).toHaveBeenCalledOnce();
    for (const method of ["get", "dialog"]) {
      form().method = method;
      expect(fill({ ...login, submit: true })).toBe("needs-human");
    }
    expect(submit).toHaveBeenCalledOnce();
  });
  it("requires human help for cross-origin submission and does not expose a secret in the result", () => {
    using _page = loginPage();
    form().action = "https://other.example";
    expect(fill(login)).toBe("needs-human");
    expect(password().value).toBe("");
  });
});
