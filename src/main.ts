import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { GenerateContentModal } from "./actions/generate-content-modal";
import { runSelectionAction, SelectionActionType } from "./actions/selection-actions";
import { ChatService } from "./chat/chat-service";
import { AI_CHAT_VIEW_TYPE, AIChatView } from "./chat/chat-view";
import { StoredChatMessage, StoredChatSession } from "./chat/types";
import { ContextScope } from "./context/scope-types";
import { ContextScopeResolver } from "./context/scope-resolver";
import { ContextScopeSwitcherModal } from "./context/scope-switcher-modal";
import { SelfCheckItem, SelfCheckModal } from "./diagnostics/self-check-modal";
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
import { EditorSubmenuController } from "./ui/editor-submenu-controller";

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
  private lastMarkdownView?: MarkdownView;
  private editorSubmenuController!: EditorSubmenuController;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.providerRegistry = new ProviderRegistry(this.settings.providers);
    this.contextScopeResolver = new ContextScopeResolver(this.app);
    this.textSearchService = new TextSearchService(this.app);
    this.templateService = new TemplateService(this.settings.promptTemplates);
    this.knowledgeAnalysisService = new KnowledgeAnalysisService(this.app);
    this.chatService = new ChatService(this);
    this.contextScopeManager = new ContextScopeManager(this);
    this.providerManager = new ProviderManager(this);
    this.draftManager = new DraftManager(this);
    this.editorSubmenuController = new EditorSubmenuController(this);

    this.registerView(AI_CHAT_VIEW_TYPE, (leaf) => new AIChatView(leaf, this));
    this.captureActiveMarkdownView();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastMarkdownView = leaf.view;
        }
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
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addSeparator();
        menu.addItem((item) =>
          item.setTitle(this.editorSubmenuController.createMenuTitle(editor)).setIcon("sparkles")
        );
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.textSearchService.invalidateFile(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.textSearchService.invalidateFile(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.textSearchService.invalidateFile(oldPath);

        if (file instanceof TFile && file.extension === "md") {
          this.textSearchService.invalidateFile(file.path);
        }
      })
    );

    this.addSettingTab(new ObsidianAISettingTab(this.app, this));
  }

  onunload(): void {
    this.editorSubmenuController.hide();
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

  // --- Delegated public API (used by other modules) ---

  getActiveContextScope(): ContextScope | undefined {
    return this.contextScopeManager.getActive();
  }

  countFilesInContextScope(scope: ContextScope | undefined): number {
    return this.contextScopeManager.countFiles(scope);
  }

  async setActiveContextScope(scopeId: string): Promise<void> {
    await this.contextScopeManager.setActive(scopeId);
    await this.syncActiveChatSessionContext();
  }

  async addContextScope(scope: ContextScope): Promise<void> {
    await this.contextScopeManager.add(scope);
    await this.syncActiveChatSessionContext();
  }

  async removeContextScope(scopeId: string): Promise<void> {
    await this.contextScopeManager.remove(scopeId);
    await this.syncActiveChatSessionContext();
  }

  async addProvider(provider: AIProviderConfig): Promise<void> {
    await this.providerManager.add(provider);
  }

  async removeProvider(providerId: string): Promise<void> {
    await this.providerManager.remove(providerId);
  }

  async createGeneratedNote(title: string, content: string): Promise<TFile> {
    return this.draftManager.createGeneratedNote(title, content);
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

  async createChatSession(): Promise<StoredChatSession> {
    const session = createChatSessionRecord(this.settings.activeContextScopeId);
    this.settings.chatSessions.unshift(session);
    this.settings.chatSessions = this.settings.chatSessions.slice(0, CHAT_SESSION_LIMIT);
    this.settings.activeChatSessionId = session.id;
    await this.saveSettings();
    return session;
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
      new Notice("当前上下文范围内没有可索引的 Markdown 文件。");
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
      contextScopes,
      promptTemplates: normalizePromptTemplates(saved?.promptTemplates),
      chatSessions,
      activeChatSessionId
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.providerRegistry?.update(this.settings.providers);
    this.templateService?.update(this.settings.promptTemplates);
  }

  // --- Private ---

  private captureActiveMarkdownView(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (activeView) {
      this.lastMarkdownView = activeView;
    }
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
      }
    ];
  }

  private async syncActiveChatSessionContext(): Promise<void> {
    const session = this.getActiveChatSession();

    if (session.contextScopeId === this.settings.activeContextScopeId) {
      return;
    }

    session.contextScopeId = this.settings.activeContextScopeId;
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
        messages,
        createdAt,
        updatedAt: session.updatedAt || messages[messages.length - 1]?.createdAt || createdAt
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, CHAT_SESSION_LIMIT);
}

function createChatSessionRecord(contextScopeId: string, messages: StoredChatMessage[] = []): StoredChatSession {
  const now = new Date().toISOString();
  return {
    id: `chat-${crypto.randomUUID()}`,
    title: createChatSessionTitle(messages),
    contextScopeId,
    messages: messages.slice(-CHAT_MESSAGE_LIMIT),
    createdAt: messages[0]?.createdAt || now,
    updatedAt: messages[messages.length - 1]?.createdAt || now
  };
}

function createChatSessionTitle(messages: StoredChatMessage[]): string {
  const firstQuestion = messages.find((message) => message.role === "user")?.content.replace(/\s+/g, " ").trim();

  if (!firstQuestion) {
    return "新对话";
  }

  return firstQuestion.length > 28 ? `${firstQuestion.slice(0, 28)}...` : firstQuestion;
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
