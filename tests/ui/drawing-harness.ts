import { TFile } from "obsidian";
import { AIChatView } from "../../src/chat/chat-view";
import { ExcalidrawEditService } from "../../src/diagrams/excalidraw-edit-service";

const file = new TFile("计划.excalidraw.md");
const other = new TFile("其他.excalidraw.md");
const board = document.body.createDiv({ cls: "drawing-fixture" });
board.createEl("h3", { text: file.path });
const canvas = board.createEl("canvas"); canvas.width = 660; canvas.height = 700;
const source = board.createEl("textarea", { attr: { "aria-label": "同文件源码" } });
source.value = "生成期间仍可编辑";
const initial = () => [{ id: "title", type: "text", x: 100, y: 180, width: 150, height: 30, text: "项目计划", fontSize: 20 }];
const state = {
  elements: initial() as any[], otherElements: initial() as any[], commits: 0, calls: 0, nextId: 0,
  stall: false, fail: false, lastPrompt: "", activeFile: file as TFile | null, scopeFile: file as TFile | null,
  appState: { viewModeEnabled: false, selectedElementIds: { title: true }, zoom: { value: 1 }, scrollX: 0, scrollY: 0, width: 660, height: 700 }
};
function render() {
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = "#353535";
  for (const element of state.elements.filter(el => !el.isDeleted)) {
    ctx.font = `${element.fontSize || 20}px system-ui`;
    element.text?.split("\n").forEach((line: string, index: number) => ctx.fillText(line, element.x, element.y + 24 + index * 26));
  }
}
const scene = { getAppState: () => state.appState };
const drawingView = { file, containerEl: board, getViewType: () => "excalidraw" };
const otherView = { file: other, getViewType: () => "excalidraw" };
const sessions = ["chat", "other-chat"].map(id => ({ id, title: id === "chat" ? "画布助手" : "其他对话", contextMode: "follow", contextFilePath: file.path, contextScopeId: "draw", lockedFilePaths: [], lastContextFilePaths: [], messages: id === "chat" ? [{ role: "assistant", content: "已经完成的回答\n无需再次请求模型", status: "complete", createdAt: new Date().toISOString() }] : [] }));
const scope = { id: "draw", name: "计划", mode: "files", files: [file.path], allowCloudModels: false };
const app: any = {
  metadataCache: { getFileCache: () => ({}) },
  vault: { getFiles: () => [file, other], getAbstractFileByPath: (path: string) => [file, other].find(item => item.path === path), on() { return () => {}; } },
  workspace: { getActiveFile: () => state.activeFile, getLeavesOfType: () => [{ view: drawingView }, { view: otherView }], revealLeaf() {}, on() { return () => {}; } }
};
const plugin: any = {
  app, settings: { defaultEditProviderId: "test", enableHtmlPreview: false, chatSessions: sessions, activeChatSessionId: "chat" },
  getActiveChatSession() { return sessions.find(session => session.id === this.settings.activeChatSessionId); },
  getActiveContextScope: () => scope, getChatSessionContextScope: () => scope,
  contextScopeResolver: { resolve: () => state.scopeFile ? [state.scopeFile] : [] },
  getEditableMarkdownView: () => undefined, getPendingSelectionReferences: () => [],
  async saveChatSessionMessages(id: string, messages: any[]) { const session = sessions.find(item => item.id === id)!; session.messages = structuredClone(messages); },
  async setActiveChatSession(id: string) { this.settings.activeChatSessionId = id; return this.getActiveChatSession(); },
  chatService: { async sendMessage(prompt: string, { signal }: any) {
    state.calls++; state.lastPrompt = prompt;
    if (state.stall) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    else await new Promise(resolve => setTimeout(resolve, 80));
    if (state.fail) throw new Error("模拟模型连接中断");
    return { content: JSON.stringify({ summary: "在标题下添加待办", edits: [{ type: "add-text", anchorId: "title", position: "below", text: prompt.includes("简短") ? "开会" : "准备周会" }] }) };
  } }
};
plugin.excalidrawEditService = new ExcalidrawEditService(plugin, () => ({ getAPI(target: any) {
  const key = target === otherView ? "otherElements" : "elements";
  const work = new Map<string, any>();
  return {
    style: { fontSize: 20 }, getExcalidrawAPI: () => scene, getViewElements: () => state[key],
    getViewSelectedElements: () => state.appState.selectedElementIds.title ? [state[key][0]] : [], destroy() {},
    copyViewElementsToEAforEditing(elements: any[]) { elements.forEach(element => work.set(element.id, structuredClone(element))); },
    getElement(id: string) { return work.get(id); },
    refreshTextElementSize(id: string) { const element = work.get(id); element.width = element.text.length * element.fontSize; element.height = element.fontSize * 1.25; },
    addText(x: number, y: number, text: string) { const id = `new-${state.nextId++}`; work.set(id, { id, type: "text", x, y, text, width: text.length * this.style.fontSize, height: 25, fontSize: this.style.fontSize }); return id; },
    async addElementsToView() { state.commits++; state[key] = [...new Map([...state[key].map(el => [el.id, el]), ...work]).values()]; render(); return true; }
  };
} } as any));
const view = new AIChatView({ app } as any, plugin);
view.containerEl.classList.add("drawing-chat-fixture");
(window as any).drawingFixture = {
  state, plugin, view,
  changeCanvas() { state.elements[0].text = "用户的新标题"; render(); },
  async switchSession(id: string) { await (view as any).switchSession(id); },
  async start(filePath = file.path) { await view.startDrawingEdit([file, other].find(item => item.path === filePath)); },
  async close() { await view.onClose(); view.unload(); },
  get liveTexts() { return state.elements.filter(el => !el.isDeleted).map(el => el.text); }
};
render(); void view.onOpen();
