import { TFile } from "obsidian";
import { HtmlPreviewView } from "../../src/html/html-preview-view";
import type { HtmlPreviewServerFactory } from "../../src/html/html-preview-server";

const control = new URLSearchParams(location.search).get("control")!;
const file = new (TFile as any)("site/index.html");
const request = async (path: string, body?: unknown) => {
  const response = await fetch(control + path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
const factory: HtmlPreviewServerFactory = async (options) => {
  const session = await request("/new", { allowNetwork: options.allowNetwork });
  return { ...session, setAllowNetwork: async (value: boolean) => { await request(`/network/${session.id}`, { value }); },
    close: async () => { await request(`/close/${session.id}`, {}); } };
};
const app = { vault: {
  read: async () => (await request("/source")).source,
  getAbstractFileByPath: () => file,
  on: () => () => {}
} };
const view = new HtmlPreviewView({ app } as any, factory);
(window as any).fullFixture = {
  async open() { await view.onOpen(); await view.onLoadFile(file); },
  async close() { await view.onUnloadFile(); await view.onClose(); },
  async stats() { return request("/stats"); }
};
