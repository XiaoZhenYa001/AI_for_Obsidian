import { Editor, MarkdownView, Notice, Plugin, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { GenerateContentModal } from "./actions/generate-content-modal";
import { runSelectionAction, SelectionActionType } from "./actions/selection-actions";
import { ChatService } from "./chat/chat-service";
import { AI_CHAT_VIEW_TYPE, AIChatView } from "./chat/chat-view";
import {
  ChatContextMode,
  ChatSessionConfig,
  SelectionReference,
  StoredChatMessage,
  StoredChatSession
} from "./chat/types";
import { ContextScope } from "./context/scope-types";
import { ContextScopeResolver } from "./context/scope-resolver";
import { ContextScopeSwitcherModal } from "./context/scope-switcher-modal";
import { SelfCheckItem, SelfCheckModal } from "./diagnostics/self-check-modal";
import { DiagramService } from "./diagrams/diagram-service";
import { GenerateDiagramModal } from "./diagrams/generate-diagram-modal";
import { KnowledgeAnalysisService } from "./knowledge/analysis-service";
import { KnowledgeHealthReportModal } from "./knowledge/health-report-modal";
import { ContextScopeManager, CURRENT_FILE_SCOPE_ID } from "./managers/context-scope-manager";
import { DraftManager } from "./managers/draft-manager";
import { ProviderManager } from "./managers/provider-manager";
import { ProviderRegistry } from "./providers/registry";
import { AIProviderConfig } from "./providers/types";
import { TextSearchService } from "./retrieval/text-search";
import { DEFAULT_SETTINGS } from "./settings/defaults";
import { ObsidianAISettings } from "./settings/settings";
import { ObsidianAISettingTab } from "./settings/settings-tab";
import { BUILT_IN_PROMPT_TEMPLATES } from "./templates/built-in-templates";
import { TemplateService } from "./templates/template-service";
import { PromptTemplate } from "./templates/types";
import { isContextFile, isContextFilePath } from "./utils/context-files";
import { createSelectionToolbarExtension } from "./ui/selection-toolbar";
import { enhanceMermaidArtifacts, extractMermaidSources } from "./ui/mermaid-artifact";

const CHAT_MESSAGE_LIMIT = 40;
const CHAT_SESSION_LIMIT = 30;

const SELECTION_ACTIONS: Array<{ id: string; name: string; action: SelectionActionType }> = [
  { id: "ai-explain-selection", name: "AI: Explain selection", action: "explain" },
  { id: "ai-summarize-selection", name: "AI: Summarize selection", action: "summarize" },
  { id: "ai-rewrite-selection", name: "AI: Rewrite selection", action: "rewrite" },
  { id: "ai-translate-selection", name: "AI: Translate selection", action: "translate" },
  { id: "ai-expand-selection", name: "AI: Expand selection", action: "expand" },
  { id: "ai-condense-selection", name: "AI: Condense selection", action: "condense" }
];

export default class ObsidianAIPlugin extends Plugin {
  settings!: ObsidianAISettings;
  providerRegistry!: ProviderRegistry;
  contextScopeResolver!: ContextScopeResolver;
  textSearchService!: TextSearchService;
  templateService!: TemplateService;
  knowledgeAnalysisService!: KnowledgeAnalysisService;
  chatService!: ChatService;
  contextScopeManager!: ContextScopeManager;
  providerManager!: ProviderManager;
  draftManager!: DraftManager;
  diagramService!: DiagramService;
  private lastMarkdownView?: MarkdownView;
  private statusBarEl?: HTMLElement;
  private readonly pendingSelectionReferences = new Map<string, SelectionReference[]>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.providerRegistry = new ProviderRegistry(this.settings.providers);
    this.contextScopeResolver = new ContextScopeResolver(this.app, () => this.getEditableMarkdownView()?.file || undefined);
    this.textSearchService = new TextSearchService(this.app);
    this.templateService = new TemplateService(this.settings.promptTemplates);
    this.knowledgeAnalysisService = new KnowledgeAnalysisService(this.app);
    this.chatService = new ChatService(this);
    this.contextScopeManager = new ContextScopeManager(this);
    this.providerManager = new ProviderManager(this);
    this.draftManager = new DraftManager(this);
    this.diagramService = new DiagramService(this);
    this.registerEditorExtension(createSelectionToolbarExtension(this));
    this.registerMarkdownPostProcessor((element, context) => {
      if (element.closest(".ai-second-brain-message-content, .ai-second-brain-chat-render-staging")) {
        return;
      }
      const section = context.getSectionInfo(element);
      enhanceMermaidArtifacts(element, extractMermaidSources(section?.text || ""));
    });

    this.registerView(AI_CHAT_VIEW_TYPE, (leaf) => new AIChatView(leaf, this));
    this.captureActiveMarkdownView();
    this.createStatusBarEntry();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastMarkdownView = leaf.view;
        }
        this.refreshStatusBar();
        this.refreshChatViews();
      })
    );

    this.addRibbonIcon("brain-circuit", "Open AI Second Brain", () => {
      void this.activateChatView();
    });

    this.addCommand({
      id: "open-ai-second-brain-chat",
      name: "Open AI Second Brain chat",
      callback: () => {
        void this.activateChatView();
      }
    });

    this.addCommand({
      id: "switch-ai-context-scope",
      name: "AI: Switch context scope",
      callback: () => {
        new ContextScopeSwitcherModal(this).open();
      }
    });

    this.addCommand({
      id: "analyze-ai-knowledge-health",
      name: "AI: Analyze knowledge health",
      callback: () => {
        void this.openKnowledgeHealthReport();
      }
    });

    this.addCommand({
      id: "generate-ai-moc-draft",
      name: "AI: Generate MOC draft",
      callback: () => {
        void this.draftManager.createMocDraft();
      }
    });

    this.addCommand({
      id: "generate-ai-daily-review",
      name: "AI: Generate daily review draft",
      callback: () => {
        void this.draftManager.createReviewDraft("daily");
      }
    });

    this.addCommand({
      id: "generate-ai-weekly-review",
      name: "AI: Generate weekly review draft",
      callback: () => {
        void this.draftManager.createReviewDraft("weekly");
      }
    });

    this.addCommand({
      id: "run-ai-second-brain-self-check",
      name: "AI: Run self check",
      callback: () => {
        this.openSelfCheck();
      }
    });

    this.addCommand({
      id: "rebuild-ai-local-text-index",
      name: "AI: Rebuild local text index",
      callback: () => {
        void this.rebuildActiveContextIndex();
      }
    });

    this.addCommand({
      id: "ai-generate-content",
      name: "AI: Generate content",
      editorCallback: (editor) => {
        new GenerateContentModal(this.app, this, editor).open();
      }
    });

    this.addCommand({
      id: "ai-generate-new-note",
      name: "AI: Generate new note",
      callback: () => {
        new GenerateContentModal(this.app, this).open();
      }
    });

    this.addCommand({
      id: "ai-generate-excalidraw-diagram",
      name: "AI: Generate Excalidraw diagram",
      callback: () => {
        const view = this.getEditableMarkdownView();
        new GenerateDiagramModal(this.app, this, view?.editor, view?.file || undefined).open();
      }
    });

    for (const entry of SELECTION_ACTIONS) {
      this.addCommand({
        id: entry.id,
        name: entry.name,
        editorCallback: (editor) => {
          void runSelectionAction(this, editor, entry.action);
        }
      });
    }

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (isContextFile(file)) {
          this.refreshStatusBar();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (isContextFile(file)) {
          this.textSearchService.invalidateFile(file.path);
          this.refreshStatusBar();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (isContextFile(file)) {
          this.textSearchService.invalidateFile(file.path);
          this.refreshStatusBar();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.textSearchService.invalidateFile(oldPath);

        if (isContextFile(file)) {
          this.textSearchService.invalidateFile(file.path);
        }
        this.refreshStatusBar();
      })
    );

    this.addSettingTab(new ObsidianAISettingTab(this.app, this));
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(AI_CHAT_VIEW_TYPE);
  }

  async activateChatView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE);
    let leaf: WorkspaceLeaf;

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const newLeaf = this.app.workspace.getRightLeaf(false);

      if (!newLeaf) {
        new Notice("无法打开 AI 侧边栏。");
        return;
      }

      leaf = newLeaf;
      await leaf.setViewState({
        type: AI_CHAT_VIEW_TYPE,
        active: true
      });
    }

    this.app.workspace.revealLeaf(leaf);
  }

  getEditableMarkdownView(): MarkdownView | undefined {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (activeView) {
      this.lastMarkdownView = activeView;
      return activeView;
    }

    if (this.lastMarkdownView?.file) {
      return this.lastMarkdownView;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) {
        this.lastMarkdownView = leaf.view;
        return leaf.view;
      }
    }

    return undefined;
  }

  getMarkdownViewForEditor(editor: Editor): MarkdownView | undefined {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (activeView?.editor === editor) {
      this.lastMarkdownView = activeView;
      return activeView;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.editor === editor) {
        this.lastMarkdownView = leaf.view;
        return leaf.view;
      }
    }

    return undefined;
  }

  getMarkdownViewForElement(element: HTMLElement): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(element)) {
        this.lastMarkdownView = leaf.view;
        return leaf.view;
      }
    }

    return undefined;
  }

  // --- Delegated public API (used by other modules) ---

  getActiveContextScope(): ContextScope | undefined {
    return this.getChatSessionContextScope(this.getActiveChatSession());
  }

  getChatSessionContextScope(session: StoredChatSession): ContextScope | undefined {
    const baseScope = this.settings.contextScopes.find((scope) => scope.id === session.contextScopeId);
    if (session.contextMode === "follow" && this.settings.autoRecognizeActiveFile) {
      return createSingleFileContextScope(
        this.getActiveContextFilePath(),
        "跟随当前文件",
        baseScope?.allowCloudModels ?? true
      );
    }

    if (session.contextMode === "follow" || session.contextMode === "locked") {
      return createSingleFileContextScope(
        session.contextFilePath,
        session.contextMode === "locked" ? "已锁定文件" : "当前文件",
        baseScope?.allowCloudModels ?? true
      );
    }

    return session.contextScopeOverride || baseScope;
  }

  countFilesInContextScope(scope: ContextScope | undefined): number {
    return this.contextScopeManager.countFiles(scope);
  }

  async setActiveContextScope(scopeId: string): Promise<void> {
    await this.contextScopeManager.setActive(scopeId);
    const session = this.getActiveChatSession();
    session.contextScopeOverride = undefined;
    session.contextMode = scopeId === CURRENT_FILE_SCOPE_ID ? "follow" : "manual";
    session.contextFilePath = session.contextMode === "follow" ? this.getActiveContextFilePath() : "";
    session.lockedFilePaths = [];
    session.lastContextFilePaths = [];
    session.lastContextFingerprint = "";
    session.updatedAt = new Date().toISOString();
    await this.saveSettings();
    await this.syncActiveChatSessionContext();
  }

  async setChatSessionContextSources(sessionId: string, files: string[], folders: string[]): Promise<void> {
    const session = this.settings.chatSessions.find((item) => item.id === sessionId);

    if (!session) {
      return;
    }

    const normalizedFiles = normalizeVaultPaths(files).filter(isContextFilePath);
    const normalizedFolders = normalizeVaultPaths(folders);
    const baseScope = this.settings.contextScopes.find((scope) => scope.id === session.contextScopeId);
    session.contextScopeOverride = {
      id: `session-context-${session.id}`,
      name: `已选择 ${normalizedFiles.length + normalizedFolders.length} 项`,
      mode: normalizedFiles.length > 0 && normalizedFolders.length > 0
        ? "mixed"
        : normalizedFolders.length > 0 ? "folders" : "files",
      files: normalizedFiles,
      folders: normalizedFolders,
      tags: [],
      pathRules: [],
      excludeRules: [],
      allowCloudModels: baseScope?.allowCloudModels ?? true
    };
    session.contextMode = "manual";
    session.contextFilePath = "";
    session.lockedFilePaths = [];
    session.lastContextFilePaths = [];
    session.lastContextFingerprint = "";
    session.updatedAt = new Date().toISOString();
    await this.saveSettings();
  }

  async setChatSessionContextMode(sessionId: string, mode: ChatContextMode): Promise<void> {
    const session = this.settings.chatSessions.find((item) => item.id === sessionId);

    if (!session) {
      return;
    }

    if (mode === "follow") {
      session.contextMode = "follow";
      session.contextFilePath = this.getActiveContextFilePath();
      session.contextScopeOverride = undefined;
    } else if (mode === "locked") {
      const filePath = this.getActiveContextFilePath() || this.contextScopeResolver.resolve(this.getChatSessionContextScope(session))[0]?.path;

      if (!filePath) {
        new Notice("请先打开要锁定的笔记、Canvas 或 Excalidraw 文件。");
        return;
      }

      session.contextMode = "locked";
      session.contextFilePath = filePath;
      session.contextScopeOverride = undefined;
    } else {
      session.contextMode = "manual";
    }

    session.lockedFilePaths = [];
    session.lastContextFilePaths = [];
    session.lastContextFingerprint = "";
    session.updatedAt = new Date().toISOString();
    await this.saveSettings();
    this.refreshChatViews();
  }

  addSelectionReferences(references: SelectionReference[]): void {
    if (references.length === 0) {
      return;
    }

    const sessionId = this.getActiveChatSession().id;
    const current = this.pendingSelectionReferences.get(sessionId) || [];
    const merged = [...current];

    for (const reference of references) {
      const duplicate = merged.some((item) =>
        item.filePath === reference.filePath &&
        item.fromLine === reference.fromLine &&
        item.fromCh === reference.fromCh &&
        item.toLine === reference.toLine &&
        item.toCh === reference.toCh &&
        item.text === reference.text
      );
      if (!duplicate) {
        merged.push(reference);
      }
    }

    this.pendingSelectionReferences.set(sessionId, merged.slice(-20));
    this.refreshChatViews();
    new Notice(`已添加到对话上下文 · ${merged.length} 个选区`);
  }

  getPendingSelectionReferences(sessionId = this.getActiveChatSession().id): SelectionReference[] {
    return [...(this.pendingSelectionReferences.get(sessionId) || [])];
  }

  removePendingSelectionReference(sessionId: string, referenceId: string): void {
    const next = (this.pendingSelectionReferences.get(sessionId) || []).filter((item) => item.id !== referenceId);
    this.pendingSelectionReferences.set(sessionId, next);
    this.refreshChatViews();
  }

  clearPendingSelectionReferences(sessionId: string): void {
    this.pendingSelectionReferences.delete(sessionId);
    this.refreshChatViews();
  }

  private refreshChatViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(AI_CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof AIChatView) {
        leaf.view.refreshExternalState();
      }
    }
  }

  private getActiveContextFilePath(): string {
    const active = this.app.workspace.getActiveFile();
    return isContextFile(active) ? active.path : this.getEditableMarkdownView()?.file?.path || "";
  }

  async addContextScope(scope: ContextScope): Promise<void> {
    await this.contextScopeManager.add(scope);
    await this.syncActiveChatSessionContext();
  }

  async removeContextScope(scopeId: string): Promise<void> {
    const existed = this.settings.contextScopes.some((scope) => scope.id === scopeId);
    await this.contextScopeManager.remove(scopeId);

    if (existed && !this.settings.contextScopes.some((scope) => scope.id === scopeId)) {
      const fallbackScopeId = this.settings.activeContextScopeId;

      for (const session of this.settings.chatSessions) {
        if (session.contextScopeId !== scopeId) {
          continue;
        }

        session.contextScopeId = fallbackScopeId;
        session.contextScopeOverride = undefined;
        session.contextMode = fallbackScopeId === CURRENT_FILE_SCOPE_ID ? "follow" : "manual";
        session.contextFilePath = session.contextMode === "follow" ? this.getActiveContextFilePath() : "";
        session.lockedFilePaths = [];
        session.lastContextFilePaths = [];
        session.lastContextFingerprint = "";
        session.updatedAt = new Date().toISOString();
      }

      await this.saveSettings();
    }

    await this.syncActiveChatSessionContext();
  }

  async addProvider(provider: AIProviderConfig): Promise<void> {
    await this.providerManager.add(provider);
  }

  async removeProvider(providerId: string): Promise<void> {
    await this.providerManager.remove(providerId);
  }

  async createGeneratedNote(title: string, content: string, folderPath?: string): Promise<TFile> {
    return this.draftManager.createGeneratedNote(title, content, folderPath);
  }

  // --- Chat sessions ---

  getActiveChatSession(): StoredChatSession {
    const active = this.settings.chatSessions.find((session) => session.id === this.settings.activeChatSessionId);

    if (active) {
      return active;
    }

    const fallback = this.settings.chatSessions[0] || createChatSessionRecord(this.settings.activeContextScopeId);

    if (this.settings.chatSessions.length === 0) {
      this.settings.chatSessions.push(fallback);
    }

    this.settings.activeChatSessionId = fallback.id;
    return fallback;
  }

  async createChatSession(config?: Partial<ChatSessionConfig>): Promise<StoredChatSession> {
    const session = createChatSessionRecord(config?.contextScopeId || this.settings.activeContextScopeId, [], config);
    if (session.contextMode === "follow" || session.contextMode === "locked") {
      session.contextFilePath = this.getActiveContextFilePath();
    }
    this.settings.chatSessions.unshift(session);
    this.settings.chatSessions = this.settings.chatSessions.slice(0, CHAT_SESSION_LIMIT);
    this.settings.activeChatSessionId = session.id;
    this.settings.activeContextScopeId = session.contextScopeId;
    await this.saveSettings();
    return session;
  }

  async updateChatSession(sessionId: string, config: Partial<ChatSessionConfig>): Promise<StoredChatSession | undefined> {
    const session = this.settings.chatSessions.find((item) => item.id === sessionId);

    if (!session) {
      return undefined;
    }

    if (config.title !== undefined) {
      session.title = config.title.trim() || "新对话";
    }

    if (config.purpose !== undefined) {
      session.purpose = config.purpose.trim();
    }

    if (config.autoContext !== undefined) {
      session.autoContext = config.autoContext;
    }

    if (config.contextMode !== undefined) {
      const changedMode = session.contextMode !== config.contextMode;
      session.contextMode = config.contextMode;
      if (config.contextMode === "follow" || config.contextMode === "locked") {
        session.contextFilePath = this.getActiveContextFilePath() || session.contextFilePath;
        session.contextScopeOverride = undefined;
      }
      if (changedMode) {
        session.lastContextFilePaths = [];
        session.lastContextFingerprint = "";
      }
    }

    if (config.contextScopeId && this.settings.contextScopes.some((scope) => scope.id === config.contextScopeId)) {
      const changedScope = session.contextScopeId !== config.contextScopeId;
      session.contextScopeId = config.contextScopeId;
      if (changedScope) {
        session.contextScopeOverride = undefined;
        session.lockedFilePaths = [];
        session.lastContextFilePaths = [];
        session.lastContextFingerprint = "";
      }
      if (session.id === this.settings.activeChatSessionId) {
        this.settings.activeContextScopeId = config.contextScopeId;
      }
    }

    if (config.lockedFilePaths !== undefined) {
      session.lockedFilePaths = normalizeMarkdownPaths(config.lockedFilePaths);
    }

    session.updatedAt = new Date().toISOString();
    await this.saveSettings();
    return session;
  }

  async saveChatSessionContext(
    sessionId: string,
    selectedFilePaths: string[],
    lockedFilePaths: string[],
    fingerprint: string
  ): Promise<void> {
    const session = this.settings.chatSessions.find((item) => item.id === sessionId);

    if (!session) {
      return;
    }

    session.lastContextFilePaths = normalizeMarkdownPaths(selectedFilePaths);
    session.lockedFilePaths = normalizeMarkdownPaths(lockedFilePaths);
    session.lastContextFingerprint = fingerprint;
    await this.saveSettings();
  }

  async setActiveChatSession(sessionId: string): Promise<StoredChatSession | undefined> {
    const session = this.settings.chatSessions.find((item) => item.id === sessionId);

    if (!session) {
      return undefined;
    }

    this.settings.activeChatSessionId = session.id;

    if (this.settings.contextScopes.some((scope) => scope.id === session.contextScopeId)) {
      this.settings.activeContextScopeId = session.contextScopeId;
    } else {
      session.contextScopeId = this.settings.activeContextScopeId;
    }

    await this.saveSettings();
    return session;
  }

  async saveChatSessionMessages(sessionId: string, messages: StoredChatMessage[]): Promise<void> {
    const session = this.settings.chatSessions.find((item) => item.id === sessionId);

    if (!session) {
      return;
    }

    session.messages = messages.slice(-CHAT_MESSAGE_LIMIT);
    session.updatedAt = new Date().toISOString();

    if (session.messages.length === 0) {
      session.title = "新对话";
    } else if (session.title === "新对话") {
      session.title = createChatSessionTitle(session.messages);
    }

    this.settings.chatSessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await this.saveSettings();
  }

  // --- Self check ---

  openSelfCheck(): void {
    new SelfCheckModal(
      this.app,
      this.createSelfCheckItems(),
      () => this.createSelfCheckItems()
    ).open();
  }

  // --- Knowledge health ---

  async openKnowledgeHealthReport(): Promise<void> {
    const report = await this.draftManager.createHealthReport();

    if (!report) {
      return;
    }

    new KnowledgeHealthReportModal(this.app, report, () => this.draftManager.createMocDraft(report)).open();
  }

  // --- Index ---

  async rebuildActiveContextIndex(): Promise<void> {
    const scope = this.getActiveContextScope();
    const files = this.contextScopeResolver.resolve(scope);

    if (files.length === 0) {
      new Notice("当前上下文范围内没有可索引的笔记、Canvas 或 Excalidraw 文件。");
      return;
    }

    const stats = await this.textSearchService.rebuild(files);
    new Notice(`本地索引已重建：${stats.indexedFiles} 个文件，${stats.indexedChunks} 个片段。`);
  }

  // --- Settings ---

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as (Partial<ObsidianAISettings> & {
      chatHistory?: StoredChatMessage[];
    }) | null;
    const contextScopes = normalizeContextScopes(saved?.contextScopes);
    const savedContextScopeId = contextScopes.some((scope) => scope.id === saved?.activeContextScopeId)
      ? saved!.activeContextScopeId!
      : CURRENT_FILE_SCOPE_ID;
    const chatSessions = normalizeChatSessions(saved?.chatSessions, saved?.chatHistory, savedContextScopeId);
    const activeChatSessionId = chatSessions.some((session) => session.id === saved?.activeChatSessionId)
      ? saved!.activeChatSessionId!
      : chatSessions[0].id;

    for (const session of chatSessions) {
      if (!contextScopes.some((scope) => scope.id === session.contextScopeId)) {
        session.contextScopeId = savedContextScopeId;
      }
    }

    const activeSession = chatSessions.find((session) => session.id === activeChatSessionId)!;
    this.settings = {
      providers: saved?.providers || DEFAULT_SETTINGS.providers,
      defaultChatProviderId: saved?.defaultChatProviderId || DEFAULT_SETTINGS.defaultChatProviderId,
      defaultEditProviderId: saved?.defaultEditProviderId || DEFAULT_SETTINGS.defaultEditProviderId,
      activeContextScopeId: activeSession.contextScopeId,
      autoRecognizeActiveFile: saved?.autoRecognizeActiveFile ?? DEFAULT_SETTINGS.autoRecognizeActiveFile,
      contextScopes,
      promptTemplates: normalizePromptTemplates(saved?.promptTemplates),
      chatSessions,
      activeChatSessionId,
      diagramFolder: saved?.diagramFolder || DEFAULT_SETTINGS.diagramFolder,
      diagramMaxNodes: clampDiagramMaxNodes(saved?.diagramMaxNodes),
      diagramAutoEmbed: saved?.diagramAutoEmbed ?? DEFAULT_SETTINGS.diagramAutoEmbed
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.providerRegistry?.update(this.settings.providers);
    this.templateService?.update(this.settings.promptTemplates);
    this.refreshStatusBar();
    this.refreshChatViews();
  }

  // --- Private ---

  private captureActiveMarkdownView(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (activeView) {
      this.lastMarkdownView = activeView;
    }
  }

  private createStatusBarEntry(): void {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("ai-second-brain-status");
    const button = this.statusBarEl.createEl("button", {
      cls: "ai-second-brain-status-button",
      attr: { type: "button", "aria-label": "打开 AI Second Brain" }
    });
    button.addEventListener("click", () => {
      void this.activateChatView();
    });
    this.refreshStatusBar();
  }

  private refreshStatusBar(): void {
    const button = this.statusBarEl?.querySelector<HTMLButtonElement>(".ai-second-brain-status-button");
    if (!button || !this.providerRegistry || !this.contextScopeResolver) {
      return;
    }

    button.empty();
    const icon = button.createSpan({ cls: "ai-second-brain-status-icon" });
    setIcon(icon, "brain-circuit");
    const provider =
      this.providerRegistry.get(this.settings.defaultChatProviderId) ||
      this.providerRegistry.getFirstAvailable();
    const scope = this.getActiveContextScope();
    const contextFiles = this.contextScopeResolver.resolve(scope);
    const fileCount = contextFiles.length;
    const session = this.getActiveChatSession();
    const contextLabel = session.contextMode === "manual"
      ? scope?.name || "无上下文"
      : contextFiles[0]?.name || "无上下文";
    const label = button.createSpan({ cls: "ai-second-brain-status-label" });
    label.setText(provider ? `${contextLabel} · ${fileCount}` : "AI 未配置");
    button.toggleClass("is-unavailable", !provider);
    button.title = provider
      ? `聊天服务：${provider.config.name}\n上下文：${contextLabel}\n授权文件：${fileCount}\n点击打开 AI`
      : "尚未配置可用的 AI 服务商，点击打开 AI";
  }

  private createSelfCheckItems(): SelfCheckItem[] {
    const activeScope = this.getActiveContextScope();
    const providers = this.settings.providers;
    const enabledProviders = providers.filter((provider) => provider.enabled);
    const activeFileCount = this.countFilesInContextScope(activeScope);
    const defaultChatProvider = this.providerRegistry.get(this.settings.defaultChatProviderId);
    const defaultEditProvider = this.providerRegistry.get(this.settings.defaultEditProviderId);
    const localProviders = enabledProviders.filter((provider) => provider.type === "ollama");
    const indexStats = this.textSearchService.getStats();

    return [
      {
        label: "插件运行状态",
        status: "pass",
        detail: "插件已成功加载到 Obsidian 运行时。"
      },
      {
        label: "AI Provider",
        status: enabledProviders.length > 0 ? "pass" : "warn",
        detail:
          enabledProviders.length > 0
            ? `已启用 ${enabledProviders.length} 个 Provider。`
            : "还没有启用 Provider，侧边栏和编辑器 AI 操作会提示先配置服务。"
      },
      {
        label: "默认聊天 Provider",
        status: defaultChatProvider ? "pass" : "warn",
        detail: defaultChatProvider ? defaultChatProvider.config.name : "未设置或当前默认 Provider 未启用。"
      },
      {
        label: "默认编辑 Provider",
        status: defaultEditProvider ? "pass" : "warn",
        detail: defaultEditProvider ? defaultEditProvider.config.name : "未设置或当前默认 Provider 未启用。"
      },
      {
        label: "本地模型",
        status: localProviders.length > 0 ? "pass" : "warn",
        detail:
          localProviders.length > 0
            ? `已配置 ${localProviders.length} 个 Ollama Provider。`
            : "尚未配置本地 Ollama。禁止云端访问的上下文需要本地 Provider 才能使用。"
      },
      {
        label: "当前上下文",
        status: activeScope ? "pass" : "fail",
        detail: activeScope ? `${activeScope.name}，当前解析到 ${activeFileCount} 个授权文件。` : "没有可用上下文范围。"
      },
      {
        label: "Prompt 模板",
        status: this.settings.promptTemplates.length > 0 ? "pass" : "fail",
        detail: `当前有 ${this.settings.promptTemplates.length} 个模板。`
      },
      {
        label: "对话记忆",
        status: "pass",
        detail: `当前保存了 ${this.settings.chatSessions.length} 个会话、${this.settings.chatSessions.reduce(
          (count, session) => count + session.messages.length,
          0
        )} 条消息。`
      },
      {
        label: "知识库分析",
        status: activeFileCount > 0 ? "pass" : "warn",
        detail: activeFileCount > 0 ? "可以对当前上下文运行健康检查和 MOC 生成。" : "当前上下文为空，知识库分析不会产生结果。"
      },
      {
        label: "本地文本索引",
        status: indexStats.indexedFiles > 0 ? "pass" : "warn",
        detail:
          indexStats.indexedFiles > 0
            ? `已缓存 ${indexStats.indexedFiles} 个文件、${indexStats.indexedChunks} 个片段。`
            : "尚未缓存索引。发送上下文问答会自动建立，也可以运行 AI: Rebuild local text index。"
      },
      {
        label: "Excalidraw 绘图",
        status: this.diagramService.isExcalidrawAvailable() ? "pass" : "warn",
        detail: this.diagramService.isExcalidrawAvailable()
          ? "ExcalidrawAutomate 已就绪，可以创建可编辑图谱。"
          : "未检测到 Excalidraw，绘图任务会降级为 Mermaid 笔记。"
      }
    ];
  }

  private async syncActiveChatSessionContext(): Promise<void> {
    const session = this.getActiveChatSession();

    if (session.contextScopeId === this.settings.activeContextScopeId) {
      return;
    }

    session.contextScopeId = this.settings.activeContextScopeId;
    session.contextScopeOverride = undefined;
    session.contextMode = session.contextScopeId === CURRENT_FILE_SCOPE_ID ? "follow" : "manual";
    session.contextFilePath = this.getActiveContextFilePath();
    session.lockedFilePaths = [];
    session.lastContextFilePaths = [];
    session.lastContextFingerprint = "";
    session.updatedAt = new Date().toISOString();
    await this.saveSettings();
  }
}

function normalizeChatHistory(messages: StoredChatMessage[] | undefined): StoredChatMessage[] {
  return (messages || [])
    .filter((message) => (message.role === "user" || message.role === "assistant") && Boolean(message.content))
    .slice(-CHAT_MESSAGE_LIMIT)
    .map((message) => ({
      role: message.role,
      content: message.content,
      citations: message.citations || [],
      selectionReferences: normalizeSelectionReferences(message.selectionReferences),
      createdAt: message.createdAt || new Date().toISOString()
    }));
}

function normalizeChatSessions(
  sessions: StoredChatSession[] | undefined,
  legacyMessages: StoredChatMessage[] | undefined,
  contextScopeId: string
): StoredChatSession[] {
  const source = sessions && sessions.length > 0
    ? sessions
    : [createChatSessionRecord(contextScopeId, normalizeChatHistory(legacyMessages))];

  return source
    .map((session) => {
      const messages = normalizeChatHistory(session.messages);
      const createdAt = session.createdAt || messages[0]?.createdAt || new Date().toISOString();

      return {
        id: session.id || `chat-${crypto.randomUUID()}`,
        title: session.title || createChatSessionTitle(messages),
        contextScopeId: session.contextScopeId || contextScopeId,
        contextScopeOverride: normalizeSessionContextScope(session.contextScopeOverride),
        contextMode: normalizeContextMode(session),
        contextFilePath: isContextFilePath(session.contextFilePath || "") ? session.contextFilePath : "",
        purpose: session.purpose || "",
        autoContext: session.autoContext ?? true,
        lockedFilePaths: normalizeMarkdownPaths(session.lockedFilePaths || []),
        lastContextFilePaths: normalizeMarkdownPaths(session.lastContextFilePaths || []),
        lastContextFingerprint: session.lastContextFingerprint || "",
        messages,
        createdAt,
        updatedAt: session.updatedAt || messages[messages.length - 1]?.createdAt || createdAt
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, CHAT_SESSION_LIMIT);
}

function createChatSessionRecord(
  contextScopeId: string,
  messages: StoredChatMessage[] = [],
  config: Partial<ChatSessionConfig> = {}
): StoredChatSession {
  const now = new Date().toISOString();
  return {
    id: `chat-${crypto.randomUUID()}`,
    title: config.title?.trim() || createChatSessionTitle(messages),
    contextScopeId,
    contextScopeOverride: undefined,
    contextMode: config.contextMode || (contextScopeId === CURRENT_FILE_SCOPE_ID ? "follow" : "manual"),
    contextFilePath: "",
    purpose: config.purpose?.trim() || "",
    autoContext: config.autoContext ?? true,
    lockedFilePaths: normalizeMarkdownPaths(config.lockedFilePaths || []),
    lastContextFilePaths: [],
    lastContextFingerprint: "",
    messages: messages.slice(-CHAT_MESSAGE_LIMIT),
    createdAt: messages[0]?.createdAt || now,
    updatedAt: messages[messages.length - 1]?.createdAt || now
  };
}

function normalizeMarkdownPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => path.trim()).filter(isContextFilePath)))
    .slice(0, 8);
}

function normalizeVaultPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim()).filter(Boolean)));
}

function normalizeContextMode(session: StoredChatSession): ChatContextMode {
  if (session.contextMode === "follow" || session.contextMode === "locked" || session.contextMode === "manual") {
    return session.contextMode;
  }

  if (session.contextScopeOverride) {
    return "manual";
  }

  return session.contextScopeId === CURRENT_FILE_SCOPE_ID ? "follow" : "manual";
}

function normalizeSelectionReferences(references: SelectionReference[] | undefined): SelectionReference[] {
  return (references || [])
    .filter((reference) => Boolean(reference?.text?.trim()) && isContextFilePath(reference.filePath || ""))
    .slice(0, 20)
    .map((reference) => ({
      id: reference.id || `selection-${crypto.randomUUID()}`,
      filePath: reference.filePath,
      fileName: reference.fileName || reference.filePath.split("/").pop() || reference.filePath,
      fromLine: Math.max(0, reference.fromLine || 0),
      fromCh: Math.max(0, reference.fromCh || 0),
      toLine: Math.max(0, reference.toLine || reference.fromLine || 0),
      toCh: Math.max(0, reference.toCh || 0),
      text: reference.text
    }));
}

function createSingleFileContextScope(
  filePath: string | undefined,
  name: string,
  allowCloudModels: boolean
): ContextScope | undefined {
  if (!filePath || !isContextFilePath(filePath)) {
    return undefined;
  }

  return {
    id: `session-file-${filePath}`,
    name,
    mode: "files",
    files: [filePath],
    folders: [],
    tags: [],
    pathRules: [],
    excludeRules: [],
    allowCloudModels
  };
}

function normalizeSessionContextScope(scope: ContextScope | undefined): ContextScope | undefined {
  if (!scope || (scope.mode !== "files" && scope.mode !== "folders" && scope.mode !== "mixed")) {
    return undefined;
  }

  return {
    id: scope.id || `session-context-${crypto.randomUUID()}`,
    name: scope.name || "对话上下文",
    mode: scope.mode,
    files: scope.files || [],
    folders: scope.folders || [],
    tags: [],
    pathRules: [],
    excludeRules: scope.excludeRules || [],
    allowCloudModels: scope.allowCloudModels ?? true
  };
}

function createChatSessionTitle(messages: StoredChatMessage[]): string {
  const firstQuestion = messages.find((message) => message.role === "user")?.content.replace(/\s+/g, " ").trim();

  if (!firstQuestion) {
    return "新对话";
  }

  return firstQuestion.length > 28 ? `${firstQuestion.slice(0, 28)}...` : firstQuestion;
}

function clampDiagramMaxNodes(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SETTINGS.diagramMaxNodes;
  }

  return Math.max(8, Math.min(40, Math.round(value!)));
}

function normalizeContextScopes(scopes: ContextScope[] | undefined): ContextScope[] {
  const merged = scopes && scopes.length > 0 ? scopes : DEFAULT_SETTINGS.contextScopes;
  const hasCurrentFile = merged.some((scope) => scope.id === CURRENT_FILE_SCOPE_ID);
  const normalized = hasCurrentFile ? merged : [DEFAULT_SETTINGS.contextScopes[0], ...merged];

  return normalized.map((scope) => ({
    id: scope.id,
    name: scope.name || "未命名上下文",
    mode: scope.mode || "current-file",
    files: scope.files || [],
    folders: scope.folders || [],
    tags: scope.tags || [],
    pathRules: scope.pathRules || [],
    excludeRules: scope.excludeRules || [],
    allowCloudModels: scope.allowCloudModels ?? true
  }));
}

function normalizePromptTemplates(templates: PromptTemplate[] | undefined): PromptTemplate[] {
  const savedTemplates = templates || [];
  const savedById = new Map(savedTemplates.map((template) => [template.id, template]));
  const merged: PromptTemplate[] = [];

  for (const builtInTemplate of BUILT_IN_PROMPT_TEMPLATES) {
    const savedTemplate = savedById.get(builtInTemplate.id);
    merged.push({
      ...builtInTemplate,
      ...savedTemplate,
      id: builtInTemplate.id,
      task: builtInTemplate.task,
      builtIn: true
    });
  }

  for (const template of savedTemplates) {
    if (!template.builtIn && !merged.some((item) => item.id === template.id)) {
      merged.push({
        ...template,
        providerId: template.providerId || "",
        model: template.model || "",
        contextScopeId: template.contextScopeId || "",
        useContext: template.useContext ?? false,
        outputMode: template.outputMode || "append-block"
      });
    }
  }

  return merged;
}
