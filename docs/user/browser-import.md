# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. Close the source browser before importing, and allow an operating-system keyring
unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again.

On macOS, Safari imports need Full Disk Access. Choose **Allow**, drag T3 Code into the
System Settings permission list, and turn access on. **Continue** becomes available when access
is detected. macOS may require you to quit and reopen T3 Code before the grant applies; reopen
the import wizard afterward. You can revoke Full Disk Access once the import is done.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported. Partitioned cookies
are skipped on all platforms.

## Saved passwords

In the desktop browser toolbar, open **Saved logins → Import password CSV**. Export from Aside’s
Passwords settings and choose that file locally. The CSV needs `url`, `username`, and `password`
columns; `name` is optional. Delete the plaintext export after importing.

Saved logins are encrypted using your computer’s system keychain and kept separate for each
browser profile. On the matching HTTPS website, choose **Fill** to use a login. Subdomains and
non-default ports must match exactly. Incognito profiles do not use the vault.

To let an agent sign in, enable **Allow agent sign-in** for that login, then ask it to sign in on
the matching page. The agent receives an outcome rather than the saved password. A submitted
form is not confirmation that sign-in succeeded. Finish MFA, passkeys, CAPTCHA, and unsupported
forms yourself. Page inspection and scripting are protected after filling until a full navigation;
if the site stays on the same page, finish signing in and reload before resuming the agent.

Turn off agent access or remove a login from **Saved logins** at any time. This does not sign out
an existing website session. Password imports are one-time copies, stay on this computer, and
are separate from cookie imports. Web and mobile clients do not manage this desktop vault.
