import { describe, expect, it } from "vite-plus/test";
import { parsePasswordCsv, passwordOrigin } from "./PasswordImport.ts";

describe("password exports", () => {
  it("preserves quoted commas, quotes, line breaks and password whitespace", () => {
    const parsed = parsePasswordCsv(
      '\uFEFFname,url,username,password\r\nExample,https://EXAMPLE.com/login,a@example.com,"  a,""b""\r\nc  "\r\n',
    );
    expect(parsed).toEqual({
      skipped: 0,
      logins: [
        {
          name: "Example",
          origin: "https://example.com",
          username: "a@example.com",
          password: '  a,"b"\r\nc  ',
        },
      ],
    });
  });
  it("accepts alternate export headers and skips malformed or insecure records", () => {
    const parsed = parsePasswordCsv(
      "title,login_uri,login_username,login_password\nSite,https://example.com:8443/signin,me,secret\nBad,http://example.com,me,secret\nBad,https://me:pw@example.com,me,secret\nBad,https://example.com,me,\nBad,https://example.com,me,secret,extra",
    );
    expect(parsed.skipped).toBe(4);
    expect(parsed.logins[0]?.origin).toBe("https://example.com:8443");
  });
  it.each([
    "url,password\nhttps://example.com,TOPSECRET",
    'url,username,password\nhttps://example.com,me,"TOPSECRET',
  ])("does not echo malformed export values in errors", (text) => {
    try {
      parsePasswordCsv(text);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("TOPSECRET");
      expect(String(error)).not.toContain("Expected rejection");
    }
  });
  it("rejects oversized exports", () => {
    expect(() => parsePasswordCsv("x".repeat(5_000_001))).toThrow("5 MB");
  });
  it("matches exact secure origins, not lookalikes or sibling domains", () => {
    expect(passwordOrigin("https://example.com/login?q=x")).toBe("https://example.com");
    expect(passwordOrigin("https://accounts.example.com")).not.toBe(
      passwordOrigin("https://example.com"),
    );
    for (const value of [
      "http://example.com",
      "https://user@example.com",
      "javascript:alert(1)",
      "not a URL",
    ])
      expect(passwordOrigin(value)).toBeNull();
  });
});
