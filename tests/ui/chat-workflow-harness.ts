import { TFile } from "obsidian";
import { AIChatView } from "../../src/chat/chat-view";
import { GenerateContentModal } from "../../src/actions/generate-content-modal";
import { KnowledgeAnalysisService } from "../../src/knowledge/analysis-service";
import { KnowledgeHealthReportModal } from "../../src/knowledge/health-report-modal";
import { ObsidianAISettingTab } from "../../src/settings/settings-tab";
import { DEFAULT_SETTINGS } from "../../src/settings/defaults";

const note = new TFile("项目/计划.md");
const notes = [note, ...Array.from({ length: 24 }, (_, i) => new TFile(`项目/资料-${i}.md`))];
const files: any[] = [...notes];
const content = new Map(notes.map(file => [file.path, `# ${file.basename}\n\n项目资料与任务安排。`]));
const scope: any = { id: "project", name: "项目资料", mode: "files", files: notes.map(file => file.path), folders: [], tags: [], pathRules: [], excludeRules: [], allowCloudModels: true };
const localScope = { ...scope, id: "local", name: "本地资料", allowCloudModels: false };
const createSession = (id: string, title = "新对话") => ({ id, title, purpose: "", contextMode: "manual", contextScopeId: "project", autoContext: false, lockedFilePaths: [], lastContextFilePaths: [], lastContextFingerprint: "", messages: [] } as any);
const sessions = [createSession("chat", "项目思路"), createSession("other", "阅读笔记")];
sessions[0].messages = [
  { role: "user", content: "帮我梳理项目的下一步", createdAt: new Date().toISOString(), status: "complete" },
  { role: "assistant", content: "先确认目标，再列出本周的三项任务。\n\n每项任务记录负责人、完成时间和验收标准。", citations: [{ filePath: note.path, title: "计划", startLine: 1, endLine: 3, excerpt: "项目资料与任务安排。", evidenceType: "direct" }], createdAt: new Date().toISOString(), status: "complete" },
  { role: "assistant", content: '下面是一个可直接使用的计数器。\n\n```html\n<!doctype html><html><body><button onclick="this.textContent=Number(this.textContent)+1">0</button></body></html>\n```', createdAt: new Date().toISOString(), status: "complete" }
];
const state = { stall: false, calls: 0, generationCalls: 0, settingsOpened: 0, previews: [] as string[], requests: [] as any[], healthChecks: 0 };
let generationSignal: AbortSignal | undefined;
let generation: GenerateContentModal | undefined;
const app: any = {
  metadataCache: { resolvedLinks: {}, getFileCache: () => ({}) },
  setting: { open() { state.settingsOpened++; }, openTabById() {} },
  vault: {
    on() { return () => {}; }, getAllLoadedFiles: () => files, getFiles: () => files,
    getMarkdownFiles: () => files.filter(file => file.extension === "md"),
    getAbstractFileByPath: (path: string) => files.find(file => file.path === path),
    cachedRead: async (file: TFile) => content.get(file.path) || "",
    async createFolder(path: string) { files.push({ path, name: path.split("/").pop() }); },
    async create(path: string, text: string) { const file = new TFile(path); files.push(file); content.set(path, text); return file; }
  },
  workspace: { on() { return () => {}; }, getActiveFile: () => note, getLeaf: () => ({ async openFile() {} }) }
};
const plugin: any = {
  app, manifest: { id: "ai-second-brain" }, chatInputDrafts: new Map(),
  settings: { ...structuredClone(DEFAULT_SETTINGS), providers: [{ id: "cloud", name: "云端服务", type: "openai-compatible", defaultModel: "chat-model", enabled: true }, { id: "local", name: "本地服务", type: "ollama", defaultModel: "local-model", enabled: true }], defaultChatProviderId: "cloud", defaultEditProviderId: "cloud", contextScopes: [scope, localScope], activeContextScopeId: scope.id, activeChatSessionId: "chat", chatSessions: sessions, enableHtmlPreview: false },
  getActiveChatSession() { return sessions.find(session => session.id === this.settings.activeChatSessionId); },
  getChatSessionContextScope(session: any) { return this.settings.contextScopes.find((item: any) => item.id === session.contextScopeId); },
  getActiveContextScope() { return this.getChatSessionContextScope(this.getActiveChatSession()); },
  contextScopeResolver: { resolve: (current: any) => current ? notes : [] },
  countFilesInContextScope: () => notes.length,
  diagramService: { isExcalidrawAvailable: () => false },
  getEditableMarkdownView: () => undefined, getPendingSelectionReferences: () => [], clearPendingSelectionReferences() {},
  async saveChatSessionMessages(id: string, messages: any[]) { sessions.find(session => session.id === id)!.messages = structuredClone(messages); },
  async saveSettings() { view.refreshExternalState(); },
  async setActiveChatSession(id: string) { this.settings.activeChatSessionId = id; return this.getActiveChatSession(); },
  async setActiveContextScope(id: string) { this.settings.activeContextScopeId = id; this.getActiveChatSession().contextScopeId = id; await this.saveSettings(); },
  async createChatSession() { const session = createSession(`chat-${sessions.length}`); sessions.unshift(session); this.settings.activeChatSessionId = session.id; return session; },
  async createGeneratedNote(title: string, text: string) { return app.vault.create(`AI Second Brain/${title}-${files.length}.md`, text); },
  async openHtmlPreview(file: TFile) { state.previews.push(file.path); },
  async openKnowledgeHealthReport() { state.healthChecks++; const report = await this.knowledgeAnalysisService.analyze("项目", notes); new KnowledgeHealthReportModal(app, report, async () => {}).open(); },
  draftManager: { async createMocDraft() {} },
  chatService: {
    async streamMessage(_question: string, options: any) {
      state.calls++;
      state.requests.push({ contextFilePaths: options.contextFilePaths, provider: plugin.settings.defaultChatProviderId });
      return { citations: [], stream: (async function* () {
        if (state.stall) {
          await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
          throw new DOMException("停止", "AbortError");
        }
        yield "可以从一个小目标开始。";
        await new Promise(resolve => setTimeout(resolve, 20));
        yield "完成后，再整理为笔记。";
      })() };
    },
    async sendMessage(_prompt: string, options: any) {
      state.generationCalls++;
      generationSignal = options.signal;
      if (state.stall) {
        await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new DOMException("停止", "AbortError");
      }
      return { content: "# 生成草稿\n\n下一步计划。", citations: [] };
    }
  }
};
plugin.knowledgeAnalysisService = new KnowledgeAnalysisService(app);
let view: AIChatView;
async function open() {
  view = new AIChatView({ app } as any, plugin);
  view.containerEl.classList.add("chat-workflow-fixture");
  await view.onOpen();
}
(window as any).chatFixture = {
  state, plugin, get view() { return view; }, files, content,
  setWidth(width: number) { view.containerEl.style.width = `${width}px`; },
  async switchSession(id: string) { await (view as any).switchSession(id); },
  async reopen() { await view.onClose(); view.unload(); view.containerEl.remove(); await open(); },
  openGeneration() { generation = new GenerateContentModal(app, plugin); generation.open(); },
  closeGeneration() { generation?.close(); },
  generationAborted() { return generationSignal?.aborted; },
  openSettings() {
    view.containerEl.hidden = true;
    document.querySelectorAll('.modal,.notice').forEach(element => element.remove());
    const settings = new ObsidianAISettingTab(app, plugin);
    settings.containerEl.style.width = '900px';
    settings.display();
    return settings.containerEl;
  }
};
void open();
