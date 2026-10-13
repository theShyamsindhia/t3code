import * as Electron from "electron";
import type { DesktopActivitySnapshot, DesktopActivityThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const labels: Record<DesktopActivityThread["status"], string> = {
  approval: "Approval needed",
  input: "Question for you",
  failed: "Run failed",
  limited: "Usage limit reached",
  working: "Working",
  waiting: "Waiting for background work",
};
const isWorking = (thread: DesktopActivityThread) =>
  thread.status === "working" || thread.status === "waiting";
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const threadHref = (thread: DesktopActivityThread) =>
  `t3-activity://thread?${new URLSearchParams({ environmentId: thread.environmentId, threadId: thread.threadId })}`;

export function activityContent(snapshot: DesktopActivitySnapshot | null) {
  if (!snapshot) return '<p class="empty">Waiting for T3 to connect…</p>';
  const section = (title: string, count: number, threads: readonly DesktopActivityThread[]) => {
    if (count === 0) return "";
    return `<section><h2>${title}<span>${count}</span></h2>${threads
      .map(
        (thread) =>
          `<a class="thread" href="${escapeHtml(threadHref(thread))}">
        <span class="title">${escapeHtml(thread.title || "Untitled chat")}</span>
        <span class="meta">${escapeHtml(thread.project)} · ${escapeHtml(thread.environment)}</span>
        <span class="status ${isWorking(thread) ? "" : "attention"}">${labels[thread.status]}</span>
      </a>`,
      )
      .join(
        "",
      )}${count > threads.length ? `<p class="more">${count - threads.length} more in T3</p>` : ""}</section>`;
  };
  return (
    section(
      "Needs you",
      snapshot.attentionCount,
      snapshot.threads.filter((thread) => !isWorking(thread)),
    ) +
    section("Working", snapshot.workingCount, snapshot.threads.filter(isWorking)) +
    (snapshot.attentionCount + snapshot.workingCount === 0
      ? `<p class="empty">${snapshot.unavailableCount ? "No live activity to show." : "Nothing needs you right now."}</p>`
      : "") +
    (snapshot.unavailableCount
      ? `<p class="connection">${snapshot.unavailableCount} connection${snapshot.unavailableCount === 1 ? "" : "s"} unavailable. Activity may be incomplete.</p>`
      : "")
  );
}

function panelHtml(snapshot: DesktopActivitySnapshot | null) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>T3 Activity</title><style>
:root { color-scheme: light dark; --base: light-dark(#fcfcfc,#202022); --text: light-dark(#242426,#f4f4f5); --muted: light-dark(#66666b,#aaaab0); --hover: light-dark(#ededee,#303034); --line: light-dark(#e4e4e7,#37373c); --attention: light-dark(#995100,#e7b86d); }
* { box-sizing: border-box; }
html,body { margin: 0; height: 100%; }
body { background: var(--base); color: var(--text); font: 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif; user-select: none; display: flex; flex-direction: column; }
header { padding: 18px 20px 10px; font-size: 15px; font-weight: 600; }
main { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 8px; }
h2 { display: flex; justify-content: space-between; margin: 12px 10px 5px; color: var(--muted); font-size: 11px; font-weight: 500; }
h2 span { font-variant-numeric: tabular-nums; }
a { color: inherit; text-decoration: none; }
.thread { display: block; padding: 9px 10px; border-radius: 12px; }
a:hover { background: var(--hover); }
a:focus-visible { outline: 2px solid var(--text); outline-offset: -2px; }
.title,.meta,.status { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title { font-weight: 500; }
.meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
.status { color: var(--muted); font-size: 11px; margin-top: 2px; }
.attention { color: var(--attention); }
.empty { color: var(--muted); padding: 20px 10px; }
.more,.connection { color: var(--muted); font-size: 11px; margin: 8px 10px; }
footer { border-top: 1px solid var(--line); padding: 6px 10px; }
footer a { display: block; padding: 9px 10px; border-radius: 10px; }
</style></head><body><header>Activity</header><main id="content">${activityContent(snapshot)}</main>
<footer><a href="t3-activity://app">Open T3 <span aria-hidden="true">↗</span></a></footer></body></html>`;
}

export function activityPanelBounds(
  anchor: Electron.Rectangle,
  workArea: Electron.Rectangle,
  snapshot: DesktopActivitySnapshot | null,
) {
  const width = Math.min(360, workArea.width - 16);
  const groups =
    Number((snapshot?.attentionCount ?? 0) > 0) + Number((snapshot?.workingCount ?? 0) > 0);
  const height = Math.min(
    560,
    workArea.height - 16,
    Math.max(
      180,
      110 +
        (snapshot?.threads.length ?? 0) * 70 +
        groups * 32 +
        (snapshot?.unavailableCount ? 44 : 0),
    ),
  );
  return {
    width,
    height,
    x: Math.round(
      Math.max(
        workArea.x + 8,
        Math.min(anchor.x + anchor.width / 2 - width / 2, workArea.x + workArea.width - width - 8),
      ),
    ),
    y: Math.round(
      Math.max(
        workArea.y + 4,
        Math.min(anchor.y + anchor.height + 4, workArea.y + workArea.height - height - 8),
      ),
    ),
  };
}

/** Menu-bar panel and Dock shortcuts share one small, event-driven snapshot. */
export class DesktopActivityPanel {
  private snapshot: DesktopActivitySnapshot | null = null;
  private signature = "null";
  private panel: Electron.BrowserWindow | null = null;
  private readonly tray: Electron.Tray;
  private readonly open: (thread?: DesktopActivityThread) => void;
  private readonly previousDockMenu = Electron.app.dock?.getMenu() ?? null;

  constructor(open: (thread?: DesktopActivityThread) => void) {
    this.open = open;
    // Monochrome T3 template at 2x; macOS supplies the menu-bar foreground color.
    const icon = Electron.nativeImage.createFromBuffer(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPUlEQVR4nO3TQQoAIAgAQf//6fqCVGDZLHizmIsR0sWN5GT3AbZb/QgA4B9A+RkCnH4HAPAeoPwM+wOknk2Y3qFf0DcPWAAAAABJRU5ErkJggg==",
        "base64",
      ),
      { scaleFactor: 2 },
    );
    icon.setTemplateImage(true);
    this.tray = new Electron.Tray(icon);
    this.tray.setToolTip("T3 Activity");
    this.tray.on("click", () => {
      if (this.panel) this.closePanel();
      else
        void this.show().catch((error) => {
          this.closePanel();
          Effect.runSync(Effect.logWarning("Could not open T3 Activity", error));
        });
    });
    this.updateDockMenu();
  }

  private closePanel() {
    const panel = this.panel;
    this.panel = null;
    if (panel && !panel.isDestroyed()) panel.destroy();
  }

  private updateDockMenu() {
    const snapshot = this.snapshot;
    const items: Electron.MenuItemConstructorOptions[] = [];
    for (const working of [false, true]) {
      const threads = snapshot?.threads.filter((thread) => isWorking(thread) === working) ?? [];
      if (!threads.length) continue;
      if (items.length) items.push({ type: "separator" });
      items.push({ label: working ? "Working" : "Needs you", enabled: false });
      for (const thread of threads)
        items.push({
          label: `${thread.title || "Untitled chat"} — ${labels[thread.status]}`,
          click: () => this.open(thread),
        });
    }
    if (items.length) items.push({ type: "separator" });
    items.push({ label: "Open T3", click: () => this.open() });
    Electron.app.dock?.setMenu(Electron.Menu.buildFromTemplate(items));
  }

  update(snapshot: DesktopActivitySnapshot | null) {
    const signature = JSON.stringify(snapshot);
    if (signature === this.signature) return;
    this.snapshot = snapshot;
    this.signature = signature;
    this.tray.setTitle(snapshot?.attentionCount ? String(snapshot.attentionCount) : "");
    this.tray.setToolTip(
      snapshot
        ? `T3 · ${snapshot.attentionCount} need you · ${snapshot.workingCount} working${snapshot.unavailableCount ? " · connections unavailable" : ""}`
        : "T3 · Connecting",
    );
    this.updateDockMenu();
    const panel = this.panel;
    if (panel && !panel.isDestroyed() && !panel.webContents.isLoadingMainFrame()) {
      void this.render(panel);
    }
  }

  private async render(panel: Electron.BrowserWindow) {
    try {
      const anchor = this.tray.getBounds();
      panel.setBounds(
        activityPanelBounds(
          anchor,
          Electron.screen.getDisplayMatching(anchor).workArea,
          this.snapshot,
        ),
      );
      // This page has no preload or scripts. Only escaped text and our fixed links enter it.
      await panel.webContents.executeJavaScript(`(() => {
        const main = document.getElementById('content');
        const href = document.activeElement?.getAttribute('href');
        const scroll = main.scrollTop;
        main.innerHTML = ${JSON.stringify(activityContent(this.snapshot))};
        if (href) Array.from(main.querySelectorAll('a')).find(a => a.getAttribute('href') === href)?.focus({preventScroll:true});
        main.scrollTop = scroll;
      })()`);
    } catch (error) {
      if (!panel.isDestroyed())
        Effect.runSync(Effect.logWarning("Could not update T3 Activity", error));
    }
  }

  private async show() {
    const bounds = this.tray.getBounds();
    const workArea = Electron.screen.getDisplayMatching(bounds).workArea;
    const panel = new Electron.BrowserWindow({
      ...activityPanelBounds(bounds, workArea, this.snapshot),
      title: "T3 Activity",
      frame: false,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      roundedCorners: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    this.panel = panel;
    panel.on("blur", () => {
      if (this.panel === panel) this.closePanel();
    });
    panel.once("closed", () => {
      if (this.panel === panel) this.panel = null;
    });
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("before-input-event", (event, input) => {
      if (input.key === "Escape") {
        event.preventDefault();
        this.closePanel();
      }
    });
    panel.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      const target = new URL(url);
      if (target.protocol !== "t3-activity:") return;
      const thread = this.snapshot?.threads.find(
        (entry) =>
          entry.environmentId === target.searchParams.get("environmentId") &&
          entry.threadId === target.searchParams.get("threadId"),
      );
      if (target.hostname !== "app" && !(target.hostname === "thread" && thread)) return;
      this.closePanel();
      this.open(thread);
    });
    await panel.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(panelHtml(this.snapshot))}`,
    );
    if (panel.isDestroyed()) return;
    await this.render(panel);
    if (!panel.isDestroyed()) panel.show();
  }

  dispose() {
    this.closePanel();
    this.tray.destroy();
    Electron.app.dock?.setMenu(this.previousDockMenu ?? Electron.Menu.buildFromTemplate([]));
  }
}
