import { ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { isAbortError } from "../providers/errors";
import { ChatMessage } from "../providers/types";
import { Citation } from "../retrieval/types";
import { DiffPreviewModal } from "../ui/diff-preview-modal";
import { createIconButton } from "../ui/icon-button";
import { StoredChatMessage, ViewChatMessage } from "./types";

export const AI_CHAT_VIEW_TYPE = "ai-second-brain-chat-view";

export class AIChatView extends ItemView {
  private messagesEl?: HTMLElement;
  private inputEl?: HTMLTextAreaElement;
  private scopeSelectEl?: HTMLSelectElement;
  private scopeMetaEl?: HTMLElement;
  private sendButtonEl?: HTMLButtonElement;
  private stopButtonEl?: HTMLButtonElement;
  private messages: ViewChatMessage[] = [];
  private isGenerating = false;
  private abortController?: AbortController;
  private expandedCitationKeys = new Set<string>();

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
    this.messages = this.plugin.settings.chatHistory.map(toViewMessage);
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("ai-second-brain-view");

    const header = container.createDiv({ cls: "ai-second-brain-header" });
    const titleRow = header.createDiv({ cls: "ai-second-brain-header-row" });
    titleRow.createEl("div", { cls: "ai-second-brain-title", text: "AI Second Brain" });

    const clearButton = createIconButton(titleRow, "trash-2", "清空", "ai-second-brain-clear");
    clearButton.addEventListener("click", () => {
      void this.clearMessages();
    });

    const scopeControls = header.createDiv({ cls: "ai-second-brain-scope-controls" });
    this.scopeSelectEl = scopeControls.createEl("select", {
      cls: "ai-second-brain-scope-select"
    });

    this.scopeMetaEl = scopeControls.createDiv({ cls: "ai-second-brain-scope" });
    this.refreshScopeControls();

    this.scopeSelectEl.addEventListener("focus", () => {
      this.refreshScopeControls();
    });
    this.scopeSelectEl.addEventListener("pointerdown", () => {
      this.refreshScopeControls();
    });
    this.scopeSelectEl.addEventListener("change", () => {
      void this.plugin.setActiveContextScope(this.scopeSelectEl?.value || "").then(() => this.refreshScopeControls());
    });

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
    this.abortController?.abort();
    this.messagesEl = undefined;
    this.inputEl = undefined;
    this.scopeSelectEl = undefined;
    this.scopeMetaEl = undefined;
    this.sendButtonEl = undefined;
    this.stopButtonEl = undefined;
  }

  private async submit(): Promise<void> {
    if (this.isGenerating) {
      return;
    }

    const content = this.inputEl?.value.trim();

    if (!content) {
      return;
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
        history
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

      if (message.role === "assistant" && !message.content.trim() && !message.isComplete) {
        this.renderThinkingState(contentEl);
      } else {
        contentEl.setText(message.content);

        if (message.role === "assistant" && !message.isComplete) {
          contentEl.createSpan({ cls: "ai-second-brain-stream-cursor" });
        }
      }

      if (message.citations && message.citations.length > 0) {
        this.renderCitations(item, message.citations);
      }

      if (message.role === "assistant" && message.content.trim() && message.isComplete) {
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

  private renderAssistantActions(container: HTMLElement, message: ViewChatMessage): void {
    const actions = container.createDiv({ cls: "ai-second-brain-message-actions" });

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
        cls: "ai-second-brain-citation-summary"
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
    const editor = this.getActiveEditor();

    if (!editor) {
      new Notice("请先打开一个可编辑的 Markdown 笔记。");
      return;
    }

    new DiffPreviewModal(this.app, "", content, (value) => {
      editor.replaceRange(value, editor.getCursor());
    }).open();
  }

  private previewReplaceSelection(content: string): void {
    const editor = this.getActiveEditor();

    if (!editor) {
      new Notice("请先打开一个可编辑的 Markdown 笔记。");
      return;
    }

    const selection = editor.getSelection();

    if (!selection) {
      new Notice("请先选中要替换的文本。");
      return;
    }

    new DiffPreviewModal(this.app, selection, content, (value) => {
      editor.replaceSelection(value);
    }).open();
  }

  private async createNoteFromMessage(content: string): Promise<void> {
    const file = await this.plugin.createGeneratedNote("AI Chat Result", content);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private getActiveEditor() {
    return this.plugin.getEditableMarkdownView()?.editor;
  }

  private async clearMessages(): Promise<void> {
    this.abortController?.abort();
    this.messages = [];
    this.expandedCitationKeys.clear();
    this.renderMessages();
    await this.plugin.saveChatHistory([]);
  }

  private async saveMessages(): Promise<void> {
    await this.plugin.saveChatHistory(
      this.messages
        .filter((message) => message.content.trim())
        .map((message) => ({
          role: message.role,
          content: message.content,
          citations: message.citations,
          createdAt: message.createdAt || new Date().toISOString()
        }))
    );
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
  }

  private refreshScopeControls(): void {
    if (!this.scopeSelectEl || !this.scopeMetaEl) {
      return;
    }

    const currentValue = this.plugin.settings.activeContextScopeId;
    this.scopeSelectEl.empty();

    for (const scope of this.plugin.settings.contextScopes) {
      this.scopeSelectEl.createEl("option", {
        value: scope.id,
        text: scope.name
      });
    }

    this.scopeSelectEl.value = currentValue;
    const selectedScope = this.plugin.getActiveContextScope();
    const count = this.plugin.countFilesInContextScope(selectedScope);
    this.scopeMetaEl.setText(selectedScope ? `${count} 个授权文件` : "未选择上下文");
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


