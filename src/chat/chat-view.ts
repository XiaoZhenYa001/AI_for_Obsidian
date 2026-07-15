import { App, Component, FuzzySuggestModal, ItemView, MarkdownRenderer, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { isAbortError } from "../providers/errors";
import { ChatMessage } from "../providers/types";
import { Citation } from "../retrieval/types";
import { DiffPreviewModal } from "../ui/diff-preview-modal";
import { createIconButton } from "../ui/icon-button";
import { StoredChatMessage, StoredChatSession, ViewChatMessage } from "./types";
import { EditorChangeTransaction } from "../actions/editor-change-transaction";
import { GenerateDiagramModal } from "../diagrams/generate-diagram-modal";
import { confirmContextSelection } from "../context/context-selection-modal";
import { configureChatSession } from "./chat-session-modal";
import { ContextScope } from "../context/scope-types";
import { pickContextSource } from "../context/context-source-picker-modal";

export const AI_CHAT_VIEW_TYPE = "ai-second-brain-chat-view";

export class AIChatView extends ItemView {
  private messagesEl?: HTMLElement;
  private inputEl?: HTMLTextAreaElement;
  private sessionSwitcherButtonEl?: HTMLButtonElement;
  private scopePickerEl?: HTMLButtonElement;
  private scopeIconEl?: HTMLElement;
  private scopeLabelEl?: HTMLElement;
  private sendButtonEl?: HTMLButtonElement;
  private stopButtonEl?: HTMLButtonElement;
  private newSessionButtonEl?: HTMLButtonElement;
  private sessionSettingsButtonEl?: HTMLButtonElement;
  private clearButtonEl?: HTMLButtonElement;
  private messages: ViewChatMessage[] = [];
  private activeSessionId = "";
  private isGenerating = false;
  private isPreparingContext = false;
  private abortController?: AbortController;
  private expandedCitationKeys = new Set<string>();
  private messageRenderComponents: Component[] = [];
  private sessionDrafts = new Map<string, string>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianAIPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return AI_CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI Second Brain";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  async onOpen(): Promise<void> {
    const activeSession = this.plugin.getActiveChatSession();
    this.activeSessionId = activeSession.id;
    this.messages = activeSession.messages.map(toViewMessage);
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("ai-second-brain-view");

    const header = container.createDiv({ cls: "ai-second-brain-header" });
    const titleRow = header.createDiv({ cls: "ai-second-brain-header-row" });
    titleRow.createEl("div", { cls: "ai-second-brain-title", text: "AI Second Brain" });

    const headerActions = titleRow.createDiv({ cls: "ai-second-brain-header-actions" });
    this.newSessionButtonEl = createIconButton(headerActions, "square-pen", "新对话", "ai-second-brain-new-session");
    this.newSessionButtonEl.addEventListener("click", () => {
      void this.startNewSession();
    });

    this.sessionSwitcherButtonEl = createIconButton(
      headerActions,
      "messages-square",
      "切换对话",
      "ai-second-brain-session-switcher"
    );
    this.sessionSwitcherButtonEl.addEventListener("click", () => {
      this.openSessionSwitcher();
    });

    this.sessionSettingsButtonEl = createIconButton(
      headerActions,
      "settings-2",
      "当前对话设置",
      "ai-second-brain-session-settings"
    );
    this.sessionSettingsButtonEl.addEventListener("click", () => {
      void this.editCurrentSession();
    });

    this.clearButtonEl = createIconButton(headerActions, "trash-2", "清空当前对话", "ai-second-brain-clear");
    this.clearButtonEl.addEventListener("click", () => {
      void this.clearMessages();
    });

    this.refreshSessionControls();

    this.scopePickerEl = header.createEl("button", {
      cls: "ai-second-brain-scope-controls",
      attr: { type: "button", "aria-label": "选择 AI 可访问的文件或文件夹" }
    });
    this.scopeIconEl = this.scopePickerEl.createSpan({ cls: "ai-second-brain-scope-picker-icon" });
    this.scopeLabelEl = this.scopePickerEl.createSpan({ cls: "ai-second-brain-scope-picker-label" });
    const scopeChevron = this.scopePickerEl.createSpan({ cls: "ai-second-brain-scope-picker-chevron" });
    setIcon(scopeChevron, "chevron-down");
    this.scopePickerEl.addEventListener("click", () => {
      void this.openContextSourcePicker();
    });
    this.refreshScopeControls();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshScopeControls();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshScopeControls();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", () => {
        this.refreshScopeControls();
      })
    );
    this.registerEvent(
      this.app.vault.on("create", () => {
        this.refreshScopeControls();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        this.refreshScopeControls();
      })
    );

    this.messagesEl = container.createDiv({ cls: "ai-second-brain-messages" });
    this.renderMessages();

    const composer = container.createDiv({ cls: "ai-second-brain-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "ai-second-brain-input",
      attr: {
        placeholder: "向你的笔记提问，或让 AI 帮你整理思路..."
      }
    });

    this.sendButtonEl = createIconButton(composer, "send-horizontal", "发送", "ai-second-brain-send mod-cta");

    this.sendButtonEl.addEventListener("click", () => {
      void this.submit();
    });

    this.stopButtonEl = createIconButton(composer, "square", "停止", "ai-second-brain-stop");
    this.stopButtonEl.style.display = "none";
    this.stopButtonEl.addEventListener("click", () => {
      this.abortController?.abort();
    });

    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.submit();
      }
    });
  }

  async onClose(): Promise<void> {
    this.rememberCurrentDraft();
    this.abortController?.abort();
    this.clearMessageRenderComponents();
    this.messagesEl = undefined;
    this.inputEl = undefined;
    this.sessionSwitcherButtonEl = undefined;
    this.scopePickerEl = undefined;
    this.scopeIconEl = undefined;
    this.scopeLabelEl = undefined;
    this.sendButtonEl = undefined;
    this.stopButtonEl = undefined;
    this.newSessionButtonEl = undefined;
    this.sessionSettingsButtonEl = undefined;
    this.clearButtonEl = undefined;
  }

  private async submit(): Promise<void> {
    if (this.isGenerating || this.isPreparingContext) {
      return;
    }

    const content = this.inputEl?.value.trim();

    if (!content) {
      return;
    }

    const session = this.plugin.getActiveChatSession();
    let contextFilePaths: string[] | undefined;

    if (session.autoContext) {
      this.setPreparingContext(true);

      try {
        const scope = this.plugin.getChatSessionContextScope(session);
        const files = this.plugin.contextScopeResolver.resolve(scope);
        const relevantFiles = await this.plugin.textSearchService.rankFiles(content, files, 6);
        const result = await confirmContextSelection(this.app, {
          scopeName: scope?.name || "当前授权范围",
          files,
          relevantFiles,
          lockedFilePaths: session.lockedFilePaths
        });

        if (!result) {
          return;
        }

        contextFilePaths = result.selectedFilePaths;
        await this.plugin.saveChatSessionContext(session.id, result.selectedFilePaths, result.lockedFilePaths);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`准备上下文失败：${message}`);
        return;
      } finally {
        this.setPreparingContext(false);
      }
    }

    const history = toProviderHistory(this.messages);
    this.inputEl!.value = "";
    this.messages.push({ role: "user", content, isComplete: true, status: "complete", createdAt: new Date().toISOString() });
    const assistantMessage: ViewChatMessage = {
      role: "assistant",
      content: "",
      citations: [],
      isComplete: false,
      status: "streaming",
      createdAt: new Date().toISOString()
    };
    this.messages.push(assistantMessage);
    this.renderMessages();
    this.abortController = new AbortController();
    this.setGenerating(true);

    try {
      const response = await this.plugin.chatService.streamMessage(content, {
        signal: this.abortController.signal,
        history,
        contextScopeId: session.contextScopeId,
        contextScope: this.plugin.getChatSessionContextScope(session),
        contextFilePaths,
        lockedFilePaths: session.lockedFilePaths,
        systemInstruction: session.purpose
      });
      assistantMessage.citations = response.citations;

      for await (const delta of response.stream) {
        if (this.abortController.signal.aborted) {
          break;
        }

        assistantMessage.content += delta;
        this.updateLastMessageContent(assistantMessage);
      }

      if (!assistantMessage.content) {
        assistantMessage.content = this.abortController.signal.aborted ? "已停止生成。" : "没有收到 AI 响应。";
        assistantMessage.status = this.abortController.signal.aborted ? "stopped" : "error";
        this.renderMessages();
      }
    } catch (error) {
      if (isAbortError(error)) {
        assistantMessage.content = assistantMessage.content || "已停止生成。";
        assistantMessage.status = "stopped";
        this.renderMessages();
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
      assistantMessage.content = `请求失败：${message}`;
      assistantMessage.status = "error";
      this.renderMessages();
    } finally {
      if (assistantMessage.status === "streaming") {
        assistantMessage.status = "complete";
      }
      assistantMessage.isComplete = true;
      this.setGenerating(false);
      this.abortController = undefined;
      this.renderMessages();
      await this.saveMessages();
    }
  }

  private renderMessages(): void {
    if (!this.messagesEl) {
      return;
    }

    this.clearMessageRenderComponents();
    this.messagesEl.empty();

    if (this.messages.length === 0) {
      this.renderEmptyState(this.messagesEl);
      return;
    }

    for (const message of this.messages) {
      const group = this.messagesEl.createDiv({
        cls: `ai-second-brain-message-group ai-second-brain-message-group-${message.role}`
      });
      const item = group.createDiv({
        cls: `ai-second-brain-message ai-second-brain-message-${message.role}`
      });
      if (message.role === "assistant" && message.status) {
        item.addClass(`ai-second-brain-message-${message.status}`);
      }
      item.createDiv({
        cls: "ai-second-brain-message-role",
        text: message.role === "user" ? "你" : "AI"
      });
      const contentEl = item.createDiv({ cls: "ai-second-brain-message-content" });

      this.renderMessageContent(contentEl, message);

      if (message.citations && message.citations.length > 0) {
        this.renderCitations(item, message.citations);
      }

      if (
        message.role === "assistant" &&
        message.content.trim() &&
        message.isComplete &&
        message.status === "complete"
      ) {
        this.renderAssistantActions(group, message);
      }
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private updateLastMessageContent(message: ViewChatMessage): void {
    if (!this.messagesEl) {
      return;
    }

    const lastGroup = this.messagesEl.lastElementChild as HTMLElement | null;

    if (!lastGroup) {
      this.renderMessages();
      return;
    }

    const messageEl = lastGroup.querySelector<HTMLElement>(".ai-second-brain-message");

    if (!messageEl) {
      this.renderMessages();
      return;
    }

    const contentEl = messageEl.querySelector<HTMLElement>(".ai-second-brain-message-content");

    if (!contentEl) {
      this.renderMessages();
      return;
    }

    contentEl.empty();

    if (!message.content.trim() && !message.isComplete) {
      this.renderThinkingState(contentEl);
    } else {
      contentEl.setText(message.content);

      if (!message.isComplete) {
        contentEl.createSpan({ cls: "ai-second-brain-stream-cursor" });
      }
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "ai-second-brain-empty" });
    const icon = empty.createDiv({ cls: "ai-second-brain-empty-icon" });
    setIcon(icon, "sparkles");
    empty.createDiv({ cls: "ai-second-brain-empty-title", text: "准备好了" });
    empty.createDiv({ cls: "ai-second-brain-empty-copy", text: "选择上下文范围，然后开始提问。" });
  }

  private renderThinkingState(container: HTMLElement): void {
    const indicator = container.createDiv({ cls: "ai-second-brain-thinking" });
    indicator.createSpan({ cls: "ai-second-brain-thinking-label", text: "正在整理上下文" });
    const dots = indicator.createSpan({ cls: "ai-second-brain-thinking-dots" });

    for (let index = 0; index < 3; index += 1) {
      dots.createSpan();
    }
  }

  private renderMessageContent(container: HTMLElement, message: ViewChatMessage): void {
    if (message.role === "assistant" && message.isComplete && message.status === "complete") {
      container.addClass("is-rendered-markdown");
      const sourcePath = this.plugin.getEditableMarkdownView()?.file?.path || "";
      const renderComponent = this.addChild(new Component());
      this.messageRenderComponents.push(renderComponent);
      void MarkdownRenderer.render(this.app, message.content, container, sourcePath, renderComponent);
      return;
    }

    if (message.role === "assistant" && !message.content.trim() && !message.isComplete) {
      this.renderThinkingState(container);
      return;
    }

    container.setText(message.content);

    if (message.role === "assistant" && !message.isComplete) {
      container.createSpan({ cls: "ai-second-brain-stream-cursor" });
    }
  }

  private renderAssistantActions(container: HTMLElement, message: ViewChatMessage): void {
    const actions = container.createDiv({ cls: "ai-second-brain-message-actions" });

    const copyButton = createIconButton(actions, "copy", "复制");
    copyButton.addEventListener("click", () => {
      void this.copyMessage(message.content);
    });

    const diagramButton = createIconButton(actions, "workflow", "生成图谱");
    diagramButton.addEventListener("click", () => {
      const view = this.plugin.getEditableMarkdownView();
      new GenerateDiagramModal(
        this.app,
        this.plugin,
        view?.editor,
        view?.file || undefined,
        message.content,
        message.citations
      ).open();
    });

    const insertButton = createIconButton(actions, "corner-down-left", "插入到光标");
    insertButton.addEventListener("click", () => {
      this.previewInsertAtCursor(message.content);
    });

    const replaceButton = createIconButton(actions, "replace", "替换选区");
    replaceButton.addEventListener("click", () => {
      this.previewReplaceSelection(message.content);
    });

    const newNoteButton = createIconButton(actions, "file-plus-2", "新建笔记");
    newNoteButton.addEventListener("click", () => {
      void this.createNoteFromMessage(message.content);
    });
  }

  private renderCitations(container: HTMLElement, citations: Citation[]): void {
    const citationsEl = container.createDiv({ cls: "ai-second-brain-citations" });
    citationsEl.createDiv({ cls: "ai-second-brain-citations-title", text: "引用来源" });

    for (const citation of citations) {
      const citationKey = this.getCitationKey(citation);
      const isExpanded = this.expandedCitationKeys.has(citationKey);
      const item = citationsEl.createDiv({ cls: "ai-second-brain-citation" });
      item.toggleClass("is-expanded", isExpanded);

      const summary = item.createEl("button", {
        cls: "ai-second-brain-citation-summary",
        attr: { type: "button" }
      });
      const sourceIcon = summary.createSpan({ cls: "ai-second-brain-citation-icon" });
      setIcon(sourceIcon, "file-text");
      summary.createSpan({
        cls: "ai-second-brain-citation-title",
        text: `${citation.title} · ${citation.startLine}-${citation.endLine}`
      });
      const toggleIcon = summary.createSpan({ cls: "ai-second-brain-citation-toggle" });
      setIcon(toggleIcon, isExpanded ? "chevron-up" : "chevron-down");
      summary.title = `${citation.filePath} · ${citation.startLine}-${citation.endLine}`;
      summary.setAttribute("aria-expanded", String(isExpanded));
      summary.addEventListener("click", () => {
        if (this.expandedCitationKeys.has(citationKey)) {
          this.expandedCitationKeys.delete(citationKey);
        } else {
          this.expandedCitationKeys.add(citationKey);
        }

        this.renderMessages();
      });

      if (!isExpanded) {
        continue;
      }

      const detail = item.createDiv({ cls: "ai-second-brain-citation-detail" });
      detail.createDiv({ cls: "ai-second-brain-citation-path", text: citation.filePath });
      detail.createDiv({ cls: "ai-second-brain-citation-excerpt", text: citation.excerpt });
      const openButton = createIconButton(detail, "external-link", "打开来源", "ai-second-brain-citation-open");
      openButton.addEventListener("click", () => {
        void this.openCitation(citation);
      });
    }
  }

  private getCitationKey(citation: Citation): string {
    return `${citation.filePath}:${citation.startLine}-${citation.endLine}`;
  }



  private async openCitation(citation: Citation): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(citation.filePath);

    if (!(file instanceof TFile)) {
      new Notice("找不到引用的笔记文件。");
      return;
    }

    await this.plugin.app.workspace.getLeaf(false).openFile(file);
  }

  private previewInsertAtCursor(content: string): void {
    const view = this.plugin.getEditableMarkdownView();
    const editor = view?.editor;

    if (!editor || !view.file) {
      new Notice("请先打开一个可编辑的 Markdown 笔记。");
      return;
    }

    const change = EditorChangeTransaction.captureInsertion(editor, view.file.path);

    new DiffPreviewModal(this.app, "", content, (value) => {
      const currentView = this.plugin.getEditableMarkdownView();
      const result = change.apply(value, currentView?.file?.path);

      if (!result.applied) {
        new Notice(result.reason);
        return false;
      }

      return true;
    }).open();
  }

  private previewReplaceSelection(content: string): void {
    const view = this.plugin.getEditableMarkdownView();
    const editor = view?.editor;

    if (!editor || !view.file) {
      new Notice("请先打开一个可编辑的 Markdown 笔记。");
      return;
    }

    const selection = editor.getSelection();

    if (!selection) {
      new Notice("请先选中要替换的文本。");
      return;
    }

    const change = EditorChangeTransaction.captureSelection(editor, view.file.path);

    if (!change) {
      new Notice("无法锁定当前选区，请重新选择文本后再试。");
      return;
    }

    new DiffPreviewModal(this.app, selection, content, (value) => {
      const currentView = this.plugin.getEditableMarkdownView();
      const result = change.apply(value, currentView?.file?.path);

      if (!result.applied) {
        new Notice(result.reason);
        return false;
      }

      return true;
    }).open();
  }

  private async createNoteFromMessage(content: string): Promise<void> {
    try {
      const file = await this.plugin.createGeneratedNote("AI Chat Result", content);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`创建笔记失败：${message}`);
    }
  }

  private async copyMessage(content: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(content);
      new Notice("已复制 AI 回复。");
    } catch {
      new Notice("复制失败，请手动选择内容复制。");
    }
  }

  private async startNewSession(): Promise<void> {
    if (this.isGenerating) {
      new Notice("请先停止当前回答，再开始新对话。");
      return;
    }

    const config = await configureChatSession(this.app, {
      mode: "create",
      scopes: this.plugin.settings.contextScopes,
      defaultScopeId: this.plugin.settings.activeContextScopeId
    });

    if (!config) {
      return;
    }

    this.rememberCurrentDraft();
    const session = await this.plugin.createChatSession(config);
    this.activeSessionId = session.id;
    this.messages = [];
    this.expandedCitationKeys.clear();
    this.refreshSessionControls();
    this.refreshScopeControls();
    this.renderMessages();
    this.restoreSessionDraft();
    this.inputEl?.focus();
  }

  private async editCurrentSession(): Promise<void> {
    if (this.isGenerating || this.isPreparingContext) {
      return;
    }

    const session = this.plugin.getActiveChatSession();
    const config = await configureChatSession(this.app, {
      mode: "edit",
      scopes: this.plugin.settings.contextScopes,
      session,
      defaultScopeId: session.contextScopeId
    });

    if (!config) {
      return;
    }

    await this.plugin.updateChatSession(session.id, config);
    this.refreshSessionControls();
    this.refreshScopeControls();
  }

  private async switchSession(sessionId: string): Promise<void> {
    if (!sessionId || sessionId === this.activeSessionId) {
      return;
    }

    if (this.isGenerating) {
      this.refreshSessionControls();
      new Notice("请先停止当前回答，再切换对话。");
      return;
    }

    this.rememberCurrentDraft();
    const session = await this.plugin.setActiveChatSession(sessionId);

    if (!session) {
      this.refreshSessionControls();
      new Notice("找不到该对话，它可能已被删除。");
      return;
    }

    this.activeSessionId = session.id;
    this.messages = session.messages.map(toViewMessage);
    this.expandedCitationKeys.clear();
    this.refreshSessionControls();
    this.refreshScopeControls();
    this.renderMessages();
    this.restoreSessionDraft();
  }

  private async clearMessages(): Promise<void> {
    this.abortController?.abort();
    this.messages = [];
    this.expandedCitationKeys.clear();
    this.renderMessages();
    await this.plugin.saveChatSessionMessages(this.activeSessionId, []);
    this.refreshSessionControls();
  }

  private async saveMessages(): Promise<void> {
    await this.plugin.saveChatSessionMessages(
      this.activeSessionId,
      this.messages
        .filter((message) => message.content.trim())
        .map((message) => ({
          role: message.role,
          content: message.content,
          citations: message.citations,
          createdAt: message.createdAt || new Date().toISOString()
        }))
    );
    this.refreshSessionControls();
  }

  private setGenerating(value: boolean): void {
    this.isGenerating = value;

    if (this.inputEl) {
      this.inputEl.disabled = value;
    }

    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = value;
    }

    if (this.stopButtonEl) {
      this.stopButtonEl.style.display = value ? "" : "none";
    }

    if (this.sessionSwitcherButtonEl) {
      this.sessionSwitcherButtonEl.disabled = value;
    }

    if (this.scopePickerEl) {
      this.scopePickerEl.disabled = value;
    }

    if (this.newSessionButtonEl) {
      this.newSessionButtonEl.disabled = value;
    }

    if (this.sessionSettingsButtonEl) {
      this.sessionSettingsButtonEl.disabled = value;
    }

    if (this.clearButtonEl) {
      this.clearButtonEl.disabled = value;
    }
  }

  private setPreparingContext(value: boolean): void {
    this.isPreparingContext = value;

    if (this.sendButtonEl) {
      this.sendButtonEl.disabled = value;
    }

    if (this.sessionSwitcherButtonEl) {
      this.sessionSwitcherButtonEl.disabled = value;
    }

    if (this.scopePickerEl) {
      this.scopePickerEl.disabled = value;
    }

    if (this.newSessionButtonEl) {
      this.newSessionButtonEl.disabled = value;
    }

    if (this.sessionSettingsButtonEl) {
      this.sessionSettingsButtonEl.disabled = value;
    }
  }

  private refreshSessionControls(): void {
    if (!this.sessionSwitcherButtonEl) {
      return;
    }

    const session = this.plugin.settings.chatSessions.find((item) => item.id === this.activeSessionId);
    const label = session?.title || "当前对话";
    this.sessionSwitcherButtonEl.title = `切换对话：${label}`;
    this.sessionSwitcherButtonEl.setAttribute("aria-label", `切换对话：${label}`);
  }

  private openSessionSwitcher(): void {
    if (this.isGenerating || this.isPreparingContext) {
      return;
    }

    new ChatSessionSwitcherModal(
      this.app,
      this.plugin.settings.chatSessions,
      this.activeSessionId,
      (sessionId) => this.switchSession(sessionId)
    ).open();
  }

  private rememberCurrentDraft(): void {
    if (!this.activeSessionId || !this.inputEl) {
      return;
    }

    this.sessionDrafts.set(this.activeSessionId, this.inputEl.value);
  }

  private restoreSessionDraft(): void {
    if (this.inputEl) {
      this.inputEl.value = this.sessionDrafts.get(this.activeSessionId) || "";
    }
  }

  private clearMessageRenderComponents(): void {
    for (const component of this.messageRenderComponents) {
      this.removeChild(component);
    }

    this.messageRenderComponents = [];
  }

  private refreshScopeControls(): void {
    if (!this.scopePickerEl || !this.scopeIconEl || !this.scopeLabelEl) {
      return;
    }

    const selectedScope = this.plugin.getActiveContextScope();
    const files = this.plugin.contextScopeResolver.resolve(selectedScope);
    const label = selectedScope ? formatScopeSelection(selectedScope, files) : "选择文件或文件夹";
    setIcon(this.scopeIconEl, getScopeIcon(selectedScope));
    this.scopeLabelEl.setText(label);
    this.scopePickerEl.title = label;
  }

  private async openContextSourcePicker(): Promise<void> {
    if (this.isGenerating || this.isPreparingContext) {
      return;
    }

    const session = this.plugin.getActiveChatSession();
    const selection = await pickContextSource(this.app, this.plugin.getChatSessionContextScope(session));

    if (!selection) {
      return;
    }

    await this.plugin.setChatSessionContextSources(session.id, selection.files, selection.folders);
    this.refreshScopeControls();
  }
}

function formatScopeSelection(scope: ContextScope, files: TFile[]): string {
  if (scope.mode === "current-file") {
    return files[0]?.name || "未打开 Markdown 笔记";
  }

  if (scope.mode === "files" && files.length > 0 && files.length <= 2) {
    return files.map((file) => file.name).join("、");
  }

  if (scope.mode === "files" && files.length > 2) {
    return `${files.slice(0, 2).map((file) => file.name).join("、")} 等 ${files.length} 个文件`;
  }

  if (scope.mode === "folders" && scope.folders.length > 0 && scope.folders.length <= 2) {
    return scope.folders.join("、");
  }

  if (scope.mode === "folders" && scope.folders.length > 2) {
    return `${scope.folders.slice(0, 2).join("、")} 等 ${scope.folders.length} 个文件夹`;
  }

  if (scope.mode === "mixed") {
    return `${scope.files.length} 个文件 · ${scope.folders.length} 个文件夹`;
  }

  return `${scope.name} · ${files.length} 个文件`;
}

function getScopeIcon(scope: ContextScope | undefined): string {
  switch (scope?.mode) {
    case "folders":
      return "folder";
    case "files":
      return "files";
    case "tags":
      return "tags";
    case "rules":
      return "list-filter";
    case "mixed":
      return "library";
    default:
      return "file-text";
  }
}

class ChatSessionSwitcherModal extends FuzzySuggestModal<StoredChatSession> {
  constructor(
    app: App,
    private readonly sessions: StoredChatSession[],
    private readonly activeSessionId: string,
    private readonly onSelect: (sessionId: string) => Promise<void>
  ) {
    super(app);
    this.setPlaceholder("搜索并切换对话");
  }

  getItems(): StoredChatSession[] {
    return this.sessions;
  }

  getItemText(session: StoredChatSession): string {
    const current = session.id === this.activeSessionId ? "当前 · " : "";
    return `${current}${session.title}`;
  }

  onChooseItem(session: StoredChatSession): void {
    void this.onSelect(session.id);
  }
}

function toViewMessage(message: StoredChatMessage): ViewChatMessage {
  return {
    role: message.role,
    content: message.content,
    citations: message.citations,
    isComplete: true,
    status: "complete",
    createdAt: message.createdAt
  };
}

function toProviderHistory(messages: ViewChatMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.content.trim())
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}
