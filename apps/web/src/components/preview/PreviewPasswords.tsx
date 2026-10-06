import type { BrowserPasswordList, DesktopBrowserPasswords } from "@t3tools/contracts";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";

export function PreviewPasswords({
  tabId,
  passwords,
}: {
  tabId: string;
  passwords: DesktopBrowserPasswords;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BrowserPasswordList | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    void passwords.list(tabId).then(
      (result) => {
        if (active) setData(result);
      },
      (cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load saved logins.");
      },
    );
    return () => {
      active = false;
    };
  }, [open, passwords, tabId]);

  const run = async (action: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      setMessage(await action());
      setData(await passwords.list(tabId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update saved logins.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setData(null);
          setError("");
          setMessage("");
        }
      }}
    >
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Saved logins" title="Saved logins" />
        }
      >
        <KeyRound />
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Saved logins</DialogTitle>
          <DialogDescription>
            Encrypted on this computer, separate for each browser profile. Logins fill only on their
            exact HTTPS website.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !data}
              onClick={() =>
                void run(async () => {
                  const result = await passwords.importFile(tabId);
                  return result.cancelled
                    ? ""
                    : `Imported ${result.imported} logins. Skipped ${result.skipped}.`;
                })
              }
            >
              Import password CSV
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Export from Aside’s Passwords settings, then choose the file here. Supported columns:
              url, username, password, and optional name. This is a one-time import.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {message ? (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}
          {!data && !error ? (
            <p className="text-sm text-muted-foreground">Loading saved logins…</p>
          ) : null}
          {data?.logins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved logins in this profile yet.</p>
          ) : null}
          <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
            {data?.logins.map((login) => (
              <div key={login.id} className="rounded-2xl bg-muted/50 p-3">
                <p className="truncate text-sm font-medium">{login.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {login.username || "No username"} · {login.origin}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={login.allowAgent}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        void run(async () => {
                          await passwords.setAgentAccess(tabId, login.id, checked === true);
                          return checked
                            ? "Agent sign-in allowed for this login."
                            : "Agent sign-in disabled for this login.";
                        })
                      }
                    />
                    Allow agent sign-in
                  </label>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await passwords.remove(tabId, login.id);
                          return "Login removed.";
                        })
                      }
                    >
                      Remove
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || login.origin !== data.origin}
                      onClick={() =>
                        void run(async () => {
                          const result = await passwords.fill(tabId, login.id);
                          return result.status === "filled"
                            ? "Login filled. Finish signing in in the browser. Agent page access stays protected until a full navigation."
                            : "This form needs your help. Finish signing in in the browser; reload afterward if agent access remains protected.";
                        })
                      }
                    >
                      Fill
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Agent sign-in is off by default. MFA, passkeys, and CAPTCHA stay with you. Removing a
            login does not sign out an existing website session.
          </p>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
