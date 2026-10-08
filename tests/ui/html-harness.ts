import { TFile } from "obsidian";
import { HtmlPreviewView } from "../../src/html/html-preview-view";

const source = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/style.css"></head><body>
<h1>交互式 HTML 预览</h1><p>本地 CSS、JavaScript 和图片</p>
<button id="increment">增加计数</button><output id="count">0</output>
<img id="local-image" src="assets/logo.svg" width="70"><img id="remote-image" src="${window.location.origin}/remote/logo.svg" width="40">
<script src="assets/app.js"></script><script>
try { parent.document.body.dataset.exposed = 'yes'; document.body.dataset.parentAccess = 'allowed'; } catch { document.body.dataset.parentAccess = 'blocked'; }
document.body.dataset.node = typeof require;
fetch('${window.location.origin}/remote/data').then(() => document.body.dataset.network = 'allowed').catch(() => document.body.dataset.network = 'blocked');
</script></body></html>`;
const resources = new Map<string, string>([
  ["demo/page.html", source],
  ["demo/assets/style.css", '@import "../base.css"; #count {color:rgb(12, 100, 180); font-size:32px;}'],
  ["demo/base.css", 'body{font:18px system-ui;margin:36px;background:#eef7ff;}button{padding:12px;margin-right:16px}img{display:block;margin-top:20px}'],
  ["demo/assets/app.js", 'let count=0; document.querySelector("#increment").onclick=()=>document.querySelector("#count").textContent=String(++count);'],
  ["demo/assets/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="70" height="70"><rect width="70" height="70" fill="#2563eb" rx="12"/></svg>']
]);
const files = new Map([...resources.keys()].map(path => [path, new (TFile as any)(path)]));
const events = new Map<string, Set<(...args: any[]) => void>>();
let reads = 0;
let writes = 0;
let ticks = 0;
window.addEventListener("message", event => { if (event.data === "preview-tick") ticks++; });
const app = { vault: {
  read: async (file: TFile) => { reads++; return resources.get(file.path); },
  process: async (file: TFile, update: (source: string) => string) => {
    const next = update(resources.get(file.path)!); resources.set(file.path, next); writes++;
    events.get("modify")?.forEach(fn => fn(file)); return next;
  },
  create: async (path: string, source: string) => { resources.set(path, source); return new (TFile as any)(path); },
  readBinary: async (file: TFile) => new TextEncoder().encode(resources.get(file.path)).buffer,
  getAbstractFileByPath: (path: string) => files.get(path),
  on(event: string, callback: (...args: any[]) => void) {
    if (!events.has(event)) events.set(event, new Set());
    events.get(event)!.add(callback);
    return () => events.get(event)!.delete(callback);
  }
} };
let preview = new HtmlPreviewView({ app } as any);
(window as any).htmlFixture = {
  async open() { await preview.onOpen(); await preview.onLoadFile(files.get("demo/page.html")!); },
  stats() { return { reads, writes, ticks }; },
  source() { return resources.get("demo/page.html"); },
  copies() { return [...resources].filter(([path]) => path.includes("-draft-")); },
  recoveries() { return [...resources].filter(([path]) => path.includes("-recovery-")); },
  failDraftStorage() { (app as any).saveLocalStorage = () => { throw new Error("quota"); }; },
  failRecoveryWrite() { app.vault.create = async () => { throw new Error("disk full"); }; },
  setSource(text: string) { resources.set("demo/page.html", text); events.get("modify")?.forEach(fn => fn(files.get("demo/page.html"))); },
  hide() { preview.containerEl.style.display = "none"; },
  show() { preview.containerEl.style.display = ""; },
  async reopen() {
    await preview.onUnloadFile(); await preview.onClose(); preview.unload(); preview.containerEl.remove();
    preview = new HtmlPreviewView({ app } as any); await preview.onOpen(); await preview.onLoadFile(files.get("demo/page.html")!);
  },
  changeStyle() {
    resources.set("demo/assets/style.css", '@import "../base.css"; #count {color:rgb(180, 20, 30);font-size:32px;}');
    events.get("modify")?.forEach(fn => fn(files.get("demo/assets/style.css")));
  },
  changeSource() {
    resources.set("demo/page.html", source.replace("交互式 HTML 预览", "自动刷新成功"));
    events.get("modify")?.forEach(fn => fn(files.get("demo/page.html")));
  },
  async close() { await preview.onUnloadFile(); await preview.onClose(); (preview as any).unload(); }
};
