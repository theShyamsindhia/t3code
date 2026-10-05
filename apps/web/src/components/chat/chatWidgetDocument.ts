import type { ChatWidgetPresentation } from "@t3tools/contracts";

export const WIDGET_REPLY_LIMIT = 4000;
export function readWidgetReply(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("type" in value) || !("text" in value)) return null;
  return value.type === "t3-widget-response" &&
    typeof value.text === "string" &&
    value.text.length <= WIDGET_REPLY_LIMIT
    ? value.text
    : null;
}

// Escape for an HTML script element, not just JavaScript string syntax.
const scriptValue = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const policy =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** A trusted outer frame prevents the generated inner document from navigating itself to a network URL. */
export function chatWidgetDocument(
  widget: ChatWidgetPresentation,
  theme: "light" | "dark",
  initialResponse: string,
) {
  const colors =
    theme === "dark"
      ? "--background:#171719;--foreground:#f4f4f5;--muted:#b5b5bd;--accent:#e4e4e7;--border:#44444b"
      : "--background:#fafafa;--foreground:#202024;--muted:#61616b;--accent:#303038;--border:#d4d4da";
  // Initialization is not a choice. Keep a saved answer until the user interacts,
  // even when generated code calls setResponse while drawing its default state.
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:${theme};${colors}}*{box-sizing:border-box}body{margin:0;padding:4px;color:var(--foreground);font:14px/1.6 system-ui,sans-serif}button,input,select,textarea{font:inherit}button{cursor:pointer}input{accent-color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style><script>(()=>{let interacted=false;for(const type of ['pointerdown','keydown','input','change','click'])window.addEventListener(type,event=>{if(event.isTrusted)interacted=true},true);Object.defineProperty(window,'t3',{value:Object.freeze({initialResponse:${scriptValue(initialResponse)},setResponse(text){if(interacted&&typeof text==='string'&&text.length<=${WIDGET_REPLY_LIMIT})parent.postMessage({type:'t3-widget-response',text},'*')}})});})();</script></head><body>${widget.html}</body></html>`;
  // Both documents have opaque origins. Only the trusted wrapper can talk to the host;
  // messages directly from generated descendants fail the host's source check.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><script>
const frame=document.createElement('iframe');frame.title='Widget content';frame.sandbox='allow-scripts';frame.referrerPolicy='no-referrer';
let pending=null,scheduled=false;
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const data=event.data;if(!data||data.type!=='t3-widget-response'||typeof data.text!=='string'||data.text.length>${WIDGET_REPLY_LIMIT})return;pending=data.text;if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;parent.postMessage({type:'t3-widget-response',text:pending},'*')})}});
frame.srcdoc=${scriptValue(inner)};document.body.append(frame);
</script></body></html>`;
}
