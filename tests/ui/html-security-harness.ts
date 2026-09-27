import { TFile } from "obsidian";
import { HtmlPreviewView } from "../../src/html/html-preview-view";

let source = "";
let pendingRead: Promise<void> | undefined;
let releaseRead: (() => void) | undefined;
const file = new (TFile as any)("security.html");
const app = { vault: {
  async read() { await pendingRead; return source; },
  getAbstractFileByPath() { return undefined; },
  on() { return () => {}; }
} };
const preview = new HtmlPreviewView({ app } as any);
let tickCount = 0;
window.addEventListener("message", (event) => {
  if (event.data?.htmlSecurityTick === true) tickCount += 1;
});
(window as any).htmlSecurityFixture = {
  get tickCount() { return tickCount; },
  async open(html: string) { source = html; await preview.onOpen(); await preview.onLoadFile(file); },
  setSource(html: string) { source = html; },
  blockReads() { pendingRead = new Promise(resolve => { releaseRead = resolve; }); },
  releaseReads() { pendingRead = undefined; releaseRead?.(); }
};
