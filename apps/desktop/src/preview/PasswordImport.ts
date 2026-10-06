import * as Schema from "effect/Schema";

export const SavedPassword = Schema.Struct({
  id: Schema.String,
  partition: Schema.String,
  name: Schema.String,
  origin: Schema.String,
  username: Schema.String,
  password: Schema.String,
  allowAgent: Schema.Boolean,
});
export type SavedPassword = typeof SavedPassword.Type;

export class BrowserPasswordError extends Schema.TaggedError<BrowserPasswordError>()(
  "BrowserPasswordError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Credentials only match one HTTPS origin, including its port. */
export function passwordOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** RFC 4180 rows, including quoted commas, escaped quotes and multiline passwords. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === "," || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (c !== ",") {
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (c === '"' && field === "" && !closed) {
      quoted = true;
    } else {
      if (closed || c === '"')
        throw new BrowserPasswordError({
          reason: "The CSV is malformed. Export it again from your password manager.",
        });
      field += c;
    }
  }
  if (quoted)
    throw new BrowserPasswordError({ reason: "The CSV contains an unfinished quoted field." });
  row.push(field);
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

export function parsePasswordCsv(text: string) {
  if (Buffer.byteLength(text, "utf8") > 5_000_000) {
    throw new BrowserPasswordError({ reason: "Choose a password export smaller than 5 MB." });
  }
  const [header = [], ...rows] = csvRows(text.replace(/^\uFEFF/, ""));
  const columns = header.map((cell) => cell.trim().toLowerCase());
  const index = (names: string[]) => columns.findIndex((cell) => names.includes(cell));
  const url = index(["url", "website", "login_uri"]);
  const username = index(["username", "login_username"]);
  const password = index(["password", "login_password"]);
  const name = index(["name", "title"]);
  if (url < 0 || username < 0 || password < 0) {
    throw new BrowserPasswordError({
      reason: "Use a CSV export with url, username and password columns.",
    });
  }
  if (rows.length > 10_000)
    throw new BrowserPasswordError({ reason: "Import up to 10,000 logins at a time." });
  const logins: Array<Pick<SavedPassword, "name" | "origin" | "username" | "password">> = [];
  let skipped = 0;
  for (const row of rows) {
    const origin = passwordOrigin(row[url]?.trim() ?? "");
    if (row.length !== header.length || !origin || !row[password] || row[password]!.length > 4096) {
      skipped++;
      continue;
    }
    logins.push({
      origin,
      name: row[name]?.trim() || new URL(origin).hostname,
      username: row[username] ?? "",
      password: row[password]!,
    });
  }
  return { logins, skipped };
}
