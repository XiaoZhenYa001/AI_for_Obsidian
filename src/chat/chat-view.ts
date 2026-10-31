import { Component, ItemView, MarkdownRenderer, MarkdownView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { isAbortError } from "../providers/errors";
import { ChatMessage } from "../providers/types";
import { Citation } from "../retrieval/types";
import { createCitationFingerprint } from "../retrieval/citations";
import { DiffPreviewModal } from "../ui/diff-preview-modal";
import { createIconButton } from "../ui/icon-button";
import { ChatContextMode, SelectionReference, StoredChatMessage, StoredChatSession, ViewChatMessage } from "./types";
import { EditorChangeTransaction } from "../actions/editor-change-transaction";
import { GenerateDiagramModal } from "../diagrams/generate-diagram-modal";
import { confirmContextSelection } from "../context/context-selection-modal";
import { configureChatSession } from "./chat-session-modal";
import { ContextScope } from "../context/scope-types";
import { pickContextSource } from "../context/context-source-picker-modal";
import { enhanceMermaidArtifacts, extractMermaidSources } from "../ui/mermaid-artifact";
import { buildFolderAnalysisInstruction, detectFolderAnalysisIntent } from "./folder-analysis";
import { ModificationPlanModal } from "../modifications/modification-plan-modal";
import { FileAgentModal } from "../modifications/file-agent-modal";
import { ChatSessionManagerModal } from "./chat-session-manager-modal";
import { normalizeMermaidMarkdown } from "../utils/mermaid";
import { DrawingSnapshot, DrawingWriteReceipt, isExcalidrawFile } from "../diagrams/excalidraw-edit-service";
import { DrawingEditPlan, isDrawingEditRequest } from "../diagrams/drawing-edit-plan";
import { pickDrawingFile } from "../diagrams/drawing-file-picker";
import { formatDrawingPreview } from "../diagrams/drawing-chat";
import { extractHtmlDocument, saveHtmlArtifact } from "../html/html-artifact";
import { createChatComposer } from "./chat-composer";
import { confirmAction } from "../ui/confirm-modal";
import { GenerateContentModal } from "../actions/generate-content-modal";
import { AuthorizedFilesModal } from "../context/authorized-files-modal";

export const AI_CHAT_VIEW_TYPE = "ai-second-brain-chat-view";
const COLLAPSED_CITATION_COUNT = 3;

export class AIChatView extends ItemView {
  private messagesEl?: HTMLElement;
  private inputEl?: HTMLTextAreaElement;
  private sessionSwitcherButtonEl?: HTMLButtonElement;
  private scopePickerEl?: HTMLButtonElement;
  private scopeIconEl?: HTMLElement;
  private scopeLabelEl?: HTMLElement;
  private modelButtonEl?: HTMLButtonElement;
  private composer?: ReturnType<typeof createChatComposer>;
  private sendButtonEl?: HTMLButtonElement;
  private selectionReferencesEl?: HTMLElement;
  private stopButtonEl?: HTMLButtonElement;
  private newSessionButtonEl?: HTMLButtonElement;
  private sessionSettingsButtonEl?: HTMLButtonElement;
  private messages: ViewChatMessage[] = [];
  private activeSessionId = "";
  private isGenerating = false;
  private isPreparingContext = false;
  private abortController?: AbortController;
  private expandedCitationKeys = new Set<string>();
  private expandedCitationListKeys = new Set<string>();
  private citationFreshnessCache = new Map<string, boolean>();
  private messageRenderComponents: Component[] = [];
  private readonly messageGroups = new WeakMap<HTMLElement, ViewChatMessage>();
  private streamingRenderTimer?: number;
  private pendingStreamingMessage?: ViewChatMessage;
  private viewVisible = true;
  private pendingFullRender = false;
  private pendingFollowOutput = true;
  private sessionDrafts = new Map<string, string>();
  private visibleMessageCount = 60;
  private historyAnchor?: { restore: () => void; release: () => void };
  private closed = false;
  private drawingContextEl?: HTMLElement;
  private drawingButtonEl?: HTMLButtonElement;
  private drawingTarget?: TFile;
  private pendingDrawing?: { message: ViewChatMessage; snapshot: DrawingSnapshot; plan: DrawingEditPlan };
  private readonly drawingReceipts = new Map<ViewChatMessage, DrawingWriteReceipt>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianAIPlugin) {
    super(leaf);
    this.sessionDrafts = plugin.chatInputDrafts || this.sessionDrafts;
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
    this.closed = false;
    const activeSession = this.plugin.getActiveChatSession();
    this.activeSessionId = activeSession.id;
    this.messages = activeSession.messages.map(toViewMessage);
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("ai-second-brain-view");

    const header = container.createDiv({ cls: "ai-second-brain-header" });
    const titleRow = header.createDiv({ cls: "ai-second-brain-header-row" });
    this.sessionSwitcherButtonEl = createIconButton(titleRow, "messages-square", "当前对话", "ai-second-brain-session-switcher");
    this.sessionSwitcherButtonEl.addEventListener("click", () => this.openSessionSwitcher());

    const headerActions = titleRow.createDiv({ cls: "ai-second-brain-header-actions" });
    this.newSessionButtonEl = createIconButton(headerActions, "square-pen", "新对话", "ai-second-brain-new-session");
    this.newSessionButtonEl.addEventListener("click", () => {
      void this.startNewSession();
    });

    this.sessionSettingsButtonEl = createIconButton(
      headerActions,
      "ellipsis",
      "对话与工具",
      "ai-second-brain-session-settings"
    );
    this.sessionSettingsButtonEl.addEventListener("click", (event) => this.openToolsMenu(event));

    this.refreshSessionControls();

    const metadataRow = header.createDiv({ cls: "ai-second-brain-header-context" });
    this.scopePickerEl = metadataRow.createEl("button", {
      cls: "ai-second-brain-scope-controls",
      attr: { type: "button", "aria-label": "选择 AI 可访问的文件或文件夹" }
    });
    this.scopeIconEl = this.scopePickerEl.createSpan({ cls: "ai-second-brain-scope-picker-icon" });
    this.scopeLabelEl = this.scopePickerEl.createSpan({ cls: "ai-second-brain-scope-picker-label" });
    const scopeChevron = this.scopePickerEl.createSpan({ cls: "ai-second-brain-scope-picker-chevron" });
    setIcon(scopeChevron, "chevron-down");
    this.scopePickerEl.addEventListener("click", (event) => {
      this.openContextModeMenu(event);
    });
    this.refreshScopeControls();
    this.modelButtonEl = createIconButton(metadataRow, "cpu", "选择模型", "ai-second-brain-model-picker");
    this.modelButtonEl.addEventListener("click", (event) => this.openModelMenu(event));
    this.refreshModelControls();

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

    const composer = createChatComposer(container as HTMLElement, {
      send: () => { void this.submit(); },
      editDrawing: (instruction) => { void this.submitDrawingEdit(instruction); },
      stop: () => { this.abortController?.abort(); }
    });
    this.composer = composer;
    this.selectionReferencesEl = composer.referencesEl;
    this.inputEl = composer.inputEl;
    this.sendButtonEl = composer.sendButtonEl;
    this.stopButtonEl = composer.stopButtonEl;
    this.drawingContextEl = composer.drawingContextEl;
    this.drawingButtonEl = composer.drawingButtonEl;
    this.restoreSessionDraft();

    const ownerWindow = this.containerEl.ownerDocument.defaultView;
    const handleComposerShortcut = (event: KeyboardEvent): void => {
      if (
        event.target === this.inputEl &&
        !event.isComposing &&
        (event.key === "Enter" || event.code === "Enter") &&
        (event.ctrlKey || event.metaKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void this.submit();
      }
    };
    if (ownerWindow) {
      this.registerDomEvent(ownerWindow, "keydown", handleComposerShortcut, { capture: true });
    }
    this.renderPendingSelectionReferences();
    const visibility = new IntersectionObserver(entries => {
      this.viewVisible = entries.some(entry => entry.isIntersecting);
      this.updateRenderVisibility();
    });
    visibility.observe(this.containerEl);
    this.register(() => visibility.disconnect());
    this.registerDomEvent(this.containerEl.ownerDocument, "visibilitychange", () => this.updateRenderVisibility());
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.rememberCurrentDraft();
    this.abortController?.abort();
    this.resetDrawingState();
    this.clearMessageRenderComponents();
    this.messagesEl = undefined;
    this.inputEl = undefined;
    this.selectionReferencesEl = undefined;
    this.sessionSwitcherButtonEl = undefined;
    this.scopePickerEl = undefined;
    this.scopeIconEl = undefined;
    this.scopeLabelEl = undefined;
    this.sendButtonEl = undefined;
    this.stopButtonEl = undefined;
    this.newSessionButtonEl = undefined;
    this.sessionSettingsButtonEl = undefined;
    this.modelButtonEl = undefined;
    this.composer = undefined;
    this.drawingContextEl = undefined;
    this.drawingButtonEl = undefined;
  }

  refreshExternalState(): void {
    this.refreshScopeControls();
    this.refreshModelControls();
    this.renderPendingSelectionReferences();
    if (!this.isGenerating && this.messages.length === 0) this.renderMessages();
  }

  handleFileRename(oldPath: string, newPath: string): void {
    let changed = false;
    for (const message of this.messages) {
      for (const citation of message.citations || []) {
        if (citation.filePath === oldPath) {
          citation.filePath = newPath;
          changed = true;
        }
      }
      for (const reference of message.selectionReferences || []) {
        if (reference.filePath === oldPath) {
          reference.filePath = newPath;
          reference.fileName = newPath.split("/").pop() || newPath;
          changed = true;
        }
      }
    }
    if (changed) this.renderMessages();
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
    const contextFiles = this.plugin.contextScopeResolver.resolve(this.plugin.getChatSessionContextScope(session));
    const drawingFiles = contextFiles.filter((file) => isExcalidrawFile(file, this.app));
    if (this.drawingTarget || /^\/draw(?:\s|$)/i.test(content) || (contextFiles.length === 1 && drawingFiles.length === 1 && isDrawingEditRequest(content))) {
      await this.submitDrawingEdit(content, this.drawingTarget || (drawingFiles.length === 1 ? drawingFiles[0] : undefined));
      return;
    }
    const selectionReferences = this.plugin.getPendingSelectionReferences(session.id);
    const requestContent = appendSelectionReferences(content, selectionReferences);
    const baseContextScope = this.plugin.getChatSessionContextScope(session);
    const folderIntent = detectFolderAnalysisIntent(this.app, content);
    const requestContextScope: ContextScope | undefined = folderIntent
      ? {
          id: `folder-analysis-${folderIntent.folderPaths.join("|")}`,
          name: folderIntent.scopeName,
          mode: "files",
          files: folderIntent.files.map((file) => file.path),
          folders: [],
          tags: [],
          pathRules: [],
          excludeRules: [],
          allowCloudModels: baseContextScope?.allowCloudModels ?? true
        }
      : baseContextScope;
    let contextFilePaths: string[] | undefined;
    let systemInstruction = session.purpose;

    if (session.autoContext || folderIntent) {
      try {
        const scope = requestContextScope;
        const files = this.plugin.contextScopeResolver.resolve(scope);
        const fingerprint = createContextFingerprint(session, scope, files);
        const availablePaths = new Set(files.map((file) => file.path));
        const canReuseConfirmation =
          fingerprint === session.lastContextFingerprint &&
          session.lastContextFilePaths.every((path) => availablePaths.has(path));

        if (canReuseConfirmation) {
          contextFilePaths = session.lastContextFilePaths;
        } else {
          this.setPreparingContext(true);
          const relevantFiles = await this.plugin.textSearchService.rankFiles(content, files, 6);
          const result = await confirmContextSelection(this.app, {
            scopeName: scope?.name || "当前授权范围",
            files,
            relevantFiles,
            lockedFilePaths: session.lockedFilePaths,
            selectAllByDefault: Boolean(folderIntent)
          });

          if (!result) {
            return;
          }

          contextFilePaths = result.selectedFilePaths;
          const persistentLockedPaths = folderIntent ? session.lockedFilePaths : result.lockedFilePaths;
          await this.plugin.saveChatSessionContext(
            session.id,
            result.selectedFilePaths,
            persistentLockedPaths,
            createContextFingerprint(session, scope, files, persistentLockedPaths)
          );
        }

        if (folderIntent && contextFilePaths) {
          const selectedPaths = new Set(contextFilePaths);
          const selectedFiles = folderIntent.files.filter((file) => selectedPaths.has(file.path));
          const report = await this.plugin.knowledgeAnalysisService.analyze(folderIntent.scopeName, selectedFiles);
          systemInstruction = [session.purpose, buildFolderAnalysisInstruction(report)].filter(Boolean).join("\n\n");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`准备上下文失败：${message}`);
        return;
      } finally {
        this.setPreparingContext(false);
      }
    }

    if (this.closed || !this.inputEl) return;
    const history = toProviderHistory(this.messages);
    this.inputEl.value = "";
    this.sessionDrafts.delete(this.activeSessionId);
    this.messages.push({
      role: "user",
      content,
      selectionReferences,
      isComplete: true,
      status: "complete",
      createdAt: new Date().toISOString()
    });
    this.plugin.clearPendingSelectionReferences(session.id);
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
      await this.saveMessages();
      const response = await this.plugin.chatService.streamMessage(requestContent, {
        signal: this.abortController.signal,
        retrievalQuery: content,
        history,
        contextScopeId: session.contextScopeId,
        contextScope: requestContextScope,
        contextFilePaths,
        lockedFilePaths: session.lockedFilePaths,
        ensureFileCoverage: Boolean(folderIntent),
        systemInstruction
      });
      assistantMessage.citations = response.citations;

      for await (const delta of response.stream) {
        if (this.abortController.signal.aborted) {
          break;
        }

        assistantMessage.content += delta;
        this.scheduleLastMessageContentUpdate(assistantMessage);
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
      assistantMessage.content = assistantMessage.content
        ? `${assistantMessage.content}\n\n[生成中断：${message}]`
        : `请求失败：${message}`;
      assistantMessage.status = "error";
      this.renderMessages();
    } finally {
      assistantMessage.content = normalizeMermaidMarkdown(assistantMessage.content);
      if (assistantMessage.status === "streaming") {
        assistantMessage.status = this.abortController?.signal.aborted ? "stopped" : "complete";
      }
      assistantMessage.isComplete = true;
      this.setGenerating(false);
      this.abortController = undefined;
      this.renderMessages(!this.messagesEl || isNearScrollBottom(this.messagesEl));
      await this.saveMessages();
    }
  }

  private renderMessages(followOutput = true): void {
    if (this.closed || !this.messagesEl) {
      return;
    }
    if (!this.canRender()) {
      this.pendingFullRender = true;
      this.pendingFollowOutput = followOutput;
      this.cancelStreamingTimer();
      return;
    }
    this.pendingFullRender = false;

    const previousTop = this.messagesEl.scrollTop;
    const document = this.messagesEl.ownerDocument;
    const active = document.activeElement as HTMLElement | null;
    const snapshots = new Map<ViewChatMessage, { sourceTabs: boolean[]; fullscreen: boolean[]; focusClass?: string; focusIndex?: number }>();
    for (const group of Array.from(this.messagesEl.querySelectorAll<HTMLElement>(".ai-second-brain-message-group"))) {
      const message = this.messageGroups.get(group);
      if (!message) continue;
      const snapshot: { sourceTabs: boolean[]; fullscreen: boolean[]; focusClass?: string; focusIndex?: number } = {
        sourceTabs: Array.from(group.querySelectorAll<HTMLElement>(".ai-second-brain-mermaid-artifact"))
          .map(artifact => artifact.querySelectorAll<HTMLButtonElement>(".ai-second-brain-mermaid-tab")[1]?.getAttribute("aria-selected") === "true"),
        fullscreen: Array.from(group.querySelectorAll<HTMLElement>(".ai-second-brain-mermaid-artifact"))
          .map(artifact => artifact.classList.contains("is-fullscreen"))
      };
      if (active && group.contains(active)) {
        const className = Array.from(active.classList).find(name => name.startsWith("ai-second-brain-"));
        if (className) {
          snapshot.focusClass = className;
          snapshot.focusIndex = Array.from(group.querySelectorAll(`.${className}`)).indexOf(active);
        }
      }
      snapshots.set(message, snapshot);
    }
    this.clearMessageRenderComponents();
    this.messagesEl.empty();

    if (this.messages.length === 0) {
      this.renderEmptyState(this.messagesEl);
      return;
    }

    if (this.messages.length > this.visibleMessageCount) {
      const more = this.messagesEl.createEl("button", { text: "加载更早的消息" });
      more.addEventListener("click", () => this.loadEarlierMessages(more));
    }
    for (const message of this.messages.slice(-this.visibleMessageCount)) {
      const snapshot = snapshots.get(message);
      let group: HTMLElement;
      const restore = (): void => {
        if (!snapshot || !group?.isConnected) return;
        group.querySelectorAll<HTMLElement>(".ai-second-brain-mermaid-artifact").forEach((artifact, index) => {
          if (snapshot.sourceTabs[index]) artifact.querySelectorAll<HTMLButtonElement>(".ai-second-brain-mermaid-tab")[1]?.click();
          if (snapshot.fullscreen[index] && !artifact.classList.contains("is-fullscreen")) {
            artifact.querySelectorAll<HTMLButtonElement>(".ai-second-brain-mermaid-action")[1]?.click();
          }
        });
        if (snapshot.focusClass && document.activeElement === document.body) {
          const target = group.querySelectorAll<HTMLElement>(`.${snapshot.focusClass}`)[snapshot.focusIndex ?? -1];
          target?.focus({ preventScroll: true });
        }
      };
      group = this.renderMessageGroup(this.messagesEl, message, restore);
      restore();
    }

    this.messagesEl.scrollTop = followOutput ? this.messagesEl.scrollHeight : previousTop;
  }

  private loadEarlierMessages(more: HTMLButtonElement): void {
    const list = this.messagesEl;
    const anchor = list?.querySelector<HTMLElement>(".ai-second-brain-message-group");
    if (!list || !anchor || !this.canRender() || this.pendingFullRender) return;

    const previousStart = Math.max(0, this.messages.length - this.visibleMessageCount);
    if (previousStart === 0) return;
    this.visibleMessageCount += 60;
    const start = Math.max(0, this.messages.length - this.visibleMessageCount);
    this.historyAnchor?.release();
    const anchorTop = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const previousOverflowAnchor = list.style.overflowAnchor;
    list.style.overflowAnchor = "none";
    let expectedTop = list.scrollTop;
    let active = true;
    const restoreAnchor = (): void => {
      if (!active || list !== this.messagesEl ||
        !anchor.isConnected || !this.canRender()) return;
      if (Math.abs(list.scrollTop - expectedTop) > 1) {
        release();
        return;
      }
      const delta = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) > 0.5) list.scrollTop += delta;
      expectedTop = list.scrollTop;
    };
    const observer = new ResizeObserver(restoreAnchor);
    const onScroll = (): void => {
      if (Math.abs(list.scrollTop - expectedTop) > 1) release();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) release();
    };
    const release = (): void => {
      if (!active) return;
      active = false;
      observer.disconnect();
      list.style.overflowAnchor = previousOverflowAnchor;
      list.removeEventListener("scroll", onScroll);
      list.removeEventListener("wheel", release);
      list.removeEventListener("touchstart", release);
      list.removeEventListener("pointerdown", release);
      list.removeEventListener("keydown", onKeyDown);
      if (this.historyAnchor === anchoring) this.historyAnchor = undefined;
    };
    const anchoring = { restore: restoreAnchor, release };
    this.historyAnchor = anchoring;

    for (const message of this.messages.slice(start, previousStart)) {
      this.renderMessageGroup(list, message, restoreAnchor, anchor);
    }
    if (start === 0) more.remove();
    restoreAnchor();
    // Keep late Markdown, images and embeds above the reading position anchored.
    list.querySelectorAll<HTMLElement>(".ai-second-brain-message-group").forEach(group => observer.observe(group));
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("wheel", release, { passive: true });
    list.addEventListener("touchstart", release, { passive: true });
    list.addEventListener("pointerdown", release, { passive: true });
    list.addEventListener("keydown", onKeyDown);
  }

  private renderMessageGroup(
    container: HTMLElement,
    message: ViewChatMessage,
    onRendered?: () => void,
    before?: HTMLElement
  ): HTMLElement {
    const group = container.createDiv({
      cls: `ai-second-brain-message-group ai-second-brain-message-group-${message.role}`
    });
    this.messageGroups.set(group, message);
    if (before) container.insertBefore(group, before);
    const item = group.createDiv({ cls: `ai-second-brain-message ai-second-brain-message-${message.role}` });
    if (message.role === "assistant" && message.status) item.addClass(`ai-second-brain-message-${message.status}`);
    item.createDiv({ cls: "ai-second-brain-message-role", text: message.role === "user" ? "你" : "AI" });
    if (message.selectionReferences?.length) this.renderMessageSelectionReferences(item, message.selectionReferences);
    const contentEl = item.createDiv({ cls: "ai-second-brain-message-content" });
    this.renderMessageContent(contentEl, message, onRendered);
    if (message.drawing) this.renderDrawingActions(item, message);
    if (message.citations?.length) this.renderCitations(item, message.citations, this.getCitationListKey(message));
    if (message.role === "assistant" && !message.drawing && message.content.trim() && message.isComplete) {
      this.renderAssistantActions(group, message, message.status === "complete");
    }
    return group;
  }

  private async submitDrawingEdit(instruction: string, file?: TFile, directText = false): Promise<void> {
    if (this.isGenerating || this.isPreparingContext) return;
    if (!directText) instruction = instruction.replace(/^\/draw\s*/i, "").trim();
    if (!instruction) { await this.startDrawingEdit(file); return; }
    const sessionId = this.activeSessionId;
    const originalInput = this.inputEl?.value;
    this.setPreparingContext(true);
    let reply: ViewChatMessage | undefined;
    const controller = new AbortController();
    try {
      const target = await this.resolveDrawingTarget(file);
      if (!target || this.closed || sessionId !== this.activeSessionId) return;
      const previousPlan = this.pendingDrawing?.snapshot.path === target.path ? this.pendingDrawing.plan : undefined;
      const history = toProviderHistory(this.messages);
      this.expireDrawingPreview("expired");
      if (!directText) {
        this.drawingTarget = target;
        if (this.inputEl && this.inputEl.value === originalInput) {
          this.inputEl.value = "";
          this.sessionDrafts.delete(sessionId);
        }
        this.messages.push({ role: "user", content: instruction, isComplete: true, status: "complete", createdAt: new Date().toISOString() });
      }
      reply = { role: "assistant", content: directText ? "正在插入画布…" : "正在生成画布修改…", isComplete: false, status: "streaming", createdAt: new Date().toISOString(), drawing: { path: target.path, state: "expired" } };
      this.messages.push(reply);
      this.abortController = controller;
      this.setPreparingContext(false);
      this.setGenerating(true);
      this.refreshDrawingContext();
      this.renderMessages();
      const snapshot = await this.plugin.excalidrawEditService.capture(target);
      if (controller.signal.aborted || this.closed) throw new DOMException("已停止", "AbortError");
      if (directText) {
        const plan = this.plugin.excalidrawEditService.createInsertion(snapshot, instruction);
        const receipt = await this.plugin.excalidrawEditService.applyWithUndo(snapshot, plan);
        this.drawingReceipts.clear(); this.drawingReceipts.set(reply, receipt);
        reply.content = `已插入 [[${snapshot.path}]]，可撤销本次写入。`;
        reply.drawing!.state = "applied";
      } else {
        const plan = await this.plugin.excalidrawEditService.propose(snapshot, instruction, controller.signal, history, previousPlan);
        if (controller.signal.aborted || this.closed) throw new DOMException("已停止", "AbortError");
        reply.content = formatDrawingPreview(snapshot, plan);
        reply.drawing!.state = "preview";
        this.pendingDrawing = { message: reply, snapshot, plan };
      }
    } catch (error) {
      const stopped = controller.signal.aborted || isAbortError(error);
      const text = stopped ? "已停止生成，画布保持原样。" : `画布操作失败：${error instanceof Error ? error.message : String(error)}`;
      if (reply) { reply.content = text; reply.status = stopped ? "stopped" : "error"; }
      else new Notice(text);
    } finally {
      if (reply) reply.isComplete = true;
      if (reply?.status === "streaming") reply.status = "complete";
      this.setPreparingContext(false);
      this.setGenerating(false);
      this.abortController = undefined;
      this.refreshDrawingContext();
      this.renderMessages();
      if (reply) await this.saveMessages();
    }
  }

  async startDrawingEdit(file?: TFile): Promise<void> {
    if (this.isGenerating || this.isPreparingContext) return;
    this.setPreparingContext(true);
    try {
      const target = await this.resolveDrawingTarget(file);
      if (!target || this.closed) return;
      if (this.pendingDrawing?.snapshot.file !== target) this.expireDrawingPreview("expired");
      this.drawingTarget = target;
      this.refreshDrawingContext(); this.renderMessages(false);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.setPreparingContext(false); this.refreshDrawingContext(); this.inputEl?.focus(); }
  }

  private async resolveDrawingTarget(file?: TFile): Promise<TFile | undefined> {
    const candidates: Array<TFile | undefined | null> = file ? [file] : [this.drawingTarget];
    if (!file) {
      const session = this.plugin.getActiveChatSession();
      const scoped = this.plugin.contextScopeResolver.resolve(this.plugin.getChatSessionContextScope(session));
      if (scoped.length === 1) candidates.push(scoped[0]);
      candidates.push(this.plugin.getCurrentDrawingFile?.(), this.app.workspace.getActiveFile());
    }
    const target = candidates.find(item => item && isExcalidrawFile(item, this.app) && this.app.vault.getAbstractFileByPath(item.path) === item);
    if (target) return target;
    if (file) throw new Error("目标画布已移动或删除，请重新选择。");
    if (!this.app.vault.getFiles().some(item => isExcalidrawFile(item, this.app))) throw new Error("没有找到 Excalidraw 画布，请先创建或导入画布。");
    return pickDrawingFile(this.app);
  }

  private refreshDrawingContext(): void {
    if (!this.drawingContextEl) return;
    this.drawingContextEl.empty(); this.drawingContextEl.hidden = !this.drawingTarget;
    this.drawingButtonEl?.setAttribute("aria-pressed", String(Boolean(this.drawingTarget)));
    if (this.inputEl) this.inputEl.placeholder = this.drawingTarget ? "描述要修改的内容，或继续调整上面的预览…" : "向你的笔记提问，或让 AI 帮你整理思路...";
    if (!this.drawingTarget) return;
    const busy = this.isGenerating || this.isPreparingContext;
    const target = createIconButton(this.drawingContextEl, "pencil-ruler", `画布 · ${this.drawingTarget.basename}`, "ai-second-brain-drawing-target");
    target.title = `切换画布：${this.drawingTarget.path}`; target.disabled = busy;
    target.addEventListener("click", () => {
      if (this.isGenerating || this.isPreparingContext) return;
      this.setPreparingContext(true);
      void pickDrawingFile(this.app).then(file => {
        if (file && !this.closed) { this.expireDrawingPreview("expired"); this.drawingTarget = file; this.renderMessages(false); }
      }).finally(() => { this.setPreparingContext(false); this.refreshDrawingContext(); });
    });
    const exit = createIconButton(this.drawingContextEl, "x", "退出画布编辑");
    exit.disabled = busy;
    exit.addEventListener("click", () => {
      if (this.isGenerating || this.isPreparingContext) return;
      this.expireDrawingPreview("discarded"); this.drawingTarget = undefined;
      this.refreshDrawingContext(); this.renderMessages(false); void this.saveMessages();
    });
  }

  private expireDrawingPreview(state: "expired" | "discarded"): void {
    if (this.pendingDrawing?.message.drawing) this.pendingDrawing.message.drawing.state = state;
    this.pendingDrawing = undefined;
  }

  private resetDrawingState(): void {
    this.expireDrawingPreview("expired"); this.drawingTarget = undefined;
    this.drawingReceipts.clear(); this.refreshDrawingContext();
  }

  private renderDrawingActions(container: HTMLElement, message: ViewChatMessage): void {
    if (!message.isComplete || message.status !== "complete") return;
    const state = message.drawing?.state;
    const actions = container.createDiv({ cls: "ai-second-brain-drawing-actions", attr: { "aria-live": "polite" } });
    const draft = this.pendingDrawing?.message === message ? this.pendingDrawing : undefined;
    const busy = this.isGenerating || this.isPreparingContext;
    if (state === "preview" && draft) {
      const apply = actions.createEl("button", { text: "写入画布", cls: "mod-cta", attr: { type: "button" } });
      const discard = actions.createEl("button", { text: "放弃", attr: { type: "button" } });
      apply.disabled = discard.disabled = busy;
      apply.addEventListener("click", () => { void this.applyDrawingPreview(message); });
      discard.addEventListener("click", () => {
        if (this.isGenerating || this.isPreparingContext) return;
        this.expireDrawingPreview("discarded"); this.renderMessages(false); void this.saveMessages();
      });
    } else if (state === "applied") {
      actions.createSpan({ text: "已写入 · 可在画布中撤销" });
      const receipt = this.drawingReceipts.get(message);
      if (receipt) {
        const undo = actions.createEl("button", { text: "撤销本次写入", attr: { type: "button" } });
        undo.disabled = busy;
        undo.addEventListener("click", () => { void this.undoDrawingWrite(message, receipt); });
      }
    } else actions.createSpan({ text: state === "discarded" ? "已放弃，画布保持原样" : state === "undone" ? "已撤销本次写入" : "预览已失效，请重新生成" });
  }

  private async applyDrawingPreview(message: ViewChatMessage): Promise<void> {
    const draft = this.pendingDrawing;
    if (!draft || draft.message !== message || this.isGenerating || this.isPreparingContext) return;
    this.setPreparingContext(true); this.renderMessages(false);
    try {
      const receipt = await this.plugin.excalidrawEditService.applyWithUndo(draft.snapshot, draft.plan);
      this.drawingReceipts.clear(); this.drawingReceipts.set(message, receipt); message.drawing!.state = "applied";
      message.content = message.content.replace(/^待写入/, "已写入"); this.pendingDrawing = undefined;
    } catch (error) {
      this.expireDrawingPreview("expired"); new Notice(error instanceof Error ? error.message : String(error));
    } finally { this.setPreparingContext(false); this.refreshDrawingContext(); this.renderMessages(false); await this.saveMessages(); }
  }

  private async undoDrawingWrite(message: ViewChatMessage, receipt: DrawingWriteReceipt): Promise<void> {
    if (this.isGenerating || this.isPreparingContext) return;
    this.setPreparingContext(true); this.renderMessages(false);
    try {
      await this.plugin.excalidrawEditService.undo(receipt);
      message.drawing!.state = "undone"; message.content = `已撤销对 [[${receipt.snapshot.path}]] 的本次写入。`;
      this.drawingReceipts.delete(message);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.setPreparingContext(false); this.refreshDrawingContext(); this.renderMessages(false); await this.saveMessages(); }
  }

  private scheduleLastMessageContentUpdate(message: ViewChatMessage): void {
    if (this.closed) return;
    this.pendingStreamingMessage = message;
    if (!this.canRender() || this.streamingRenderTimer !== undefined) {
      return;
    }

    const ownerWindow = this.containerEl.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }

    const renderDelay = message.content.length > 12000 ? 180 : message.content.length > 4000 ? 110 : 60;
    this.streamingRenderTimer = ownerWindow.setTimeout(() => {
      this.streamingRenderTimer = undefined;
      if (!this.canRender()) return;
      const pending = this.pendingStreamingMessage;
      this.pendingStreamingMessage = undefined;
      if (pending) {
        this.updateLastMessageContent(pending);
      }
    }, renderDelay);
  }

  private updateLastMessageContent(message: ViewChatMessage): void {
    if (!this.messagesEl || !this.canRender()) {
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

    if (!message.content.trim() && !message.isComplete) {
      contentEl.empty();
      this.renderThinkingState(contentEl);
      return;
    }

    const shouldFollowOutput = isNearScrollBottom(this.messagesEl);
    // Parsing Markdown (including Mermaid) for every delta repeats all prior work.
    // Keep one text node during generation; the completed answer uses renderMessages.
    const existingText = contentEl.firstChild;
    if (existingText?.nodeType === 3) {
      const text = existingText as Text;
      if (message.content.startsWith(text.data)) text.appendData(message.content.slice(text.length));
      else text.data = message.content;
    } else {
      contentEl.empty();
      contentEl.removeClass("is-rendered-markdown");
      contentEl.appendChild(contentEl.ownerDocument.createTextNode(message.content));
      contentEl.createSpan({ cls: "ai-second-brain-stream-cursor" });
    }

    if (shouldFollowOutput && this.messagesEl) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
  }

  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "ai-second-brain-empty" });
    const icon = empty.createDiv({ cls: "ai-second-brain-empty-icon" });
    setIcon(icon, "sparkles");
    const configured = (this.plugin.settings.providers || []).some(provider => provider.enabled);
    empty.createDiv({ cls: "ai-second-brain-empty-title", text: configured ? "从你的笔记开始" : "连接一个 AI 模型" });
    empty.createDiv({ cls: "ai-second-brain-empty-copy", text: configured
      ? "上方选择资料，下方提问。回答可以保存为笔记、图谱或互动页面。"
      : "先添加服务商和模型，再开始对话。" });
    if (!configured) {
      const setup = createIconButton(empty, "settings-2", "配置 AI 服务商", "ai-second-brain-empty-action");
      setup.addEventListener("click", () => this.openPluginSettings());
    }
  }

  private renderThinkingState(container: HTMLElement): void {
    const indicator = container.createDiv({ cls: "ai-second-brain-thinking" });
    indicator.createSpan({ cls: "ai-second-brain-thinking-label", text: "正在整理上下文" });
    const dots = indicator.createSpan({ cls: "ai-second-brain-thinking-dots" });

    for (let index = 0; index < 3; index += 1) {
      dots.createSpan();
    }
  }

  private renderMessageSelectionReferences(container: HTMLElement, references: SelectionReference[]): void {
    const list = container.createDiv({ cls: "ai-second-brain-message-references" });
    for (const reference of references) {
      const button = list.createEl("button", {
        cls: "ai-second-brain-message-reference",
        attr: {
          type: "button",
          title: reference.text
        }
      });
      const icon = button.createSpan({ cls: "ai-second-brain-message-reference-icon" });
      setIcon(icon, "text-quote");
      button.createSpan({
        cls: "ai-second-brain-message-reference-label",
        text: `${reference.fileName} · ${formatLineRange(reference)}`
      });
      button.addEventListener("click", () => {
        void this.openSelectionReference(reference);
      });
    }
  }

  private renderMessageContent(container: HTMLElement, message: ViewChatMessage, onRendered?: () => void): void {
    const draft = this.pendingDrawing?.message === message ? this.pendingDrawing : undefined;
    if (draft) {
      container.addClass("ai-second-brain-drawing-preview");
      container.createDiv({ cls: "ai-second-brain-drawing-preview-target", text: `待写入 · ${draft.snapshot.file.name}` });
      container.createDiv({ cls: "ai-second-brain-drawing-preview-summary", text: draft.plan.summary });
      const elements = new Map(draft.snapshot.elements.map(element => [element.id, element]));
      for (const edit of draft.plan.edits) {
        const row = container.createDiv({ cls: "ai-second-brain-drawing-preview-edit" });
        row.createDiv({ cls: "ai-second-brain-drawing-preview-label", text: edit.type === "add-text" ? "新增文本" : "修改文本" });
        const original = edit.elementId ? elements.get(edit.elementId) : undefined;
        if (original) row.createDiv({ cls: "ai-second-brain-drawing-preview-before", text: original.rawText || original.originalText || original.text || "" });
        row.createDiv({ cls: "ai-second-brain-drawing-preview-text", text: edit.text });
      }
      return;
    }
    if (message.role === "assistant" && message.isComplete && message.content.trim()) {
      container.addClass("is-rendered-markdown");
      const sourcePath = this.plugin.getEditableMarkdownView()?.file?.path || "";
      const renderComponent = this.addChild(new Component());
      this.messageRenderComponents.push(renderComponent);
      void MarkdownRenderer.render(this.app, message.content, container, sourcePath, renderComponent).then(() => {
        if (container.isConnected) {
          enhanceMermaidArtifacts(container, extractMermaidSources(message.content));
          this.enhanceInlineCitations(container, message.citations || []);
          onRendered?.();
        }
      });
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

  private renderAssistantActions(
    container: HTMLElement,
    message: ViewChatMessage,
    includeWriteActions: boolean
  ): void {
    const actions = container.createDiv({ cls: "ai-second-brain-message-actions" });

    const copyButton = createIconButton(actions, "copy", "复制");
    copyButton.addEventListener("click", () => {
      void this.copyMessage(message.content);
    });

    if (!includeWriteActions) {
      return;
    }
    const saveButton = createIconButton(actions, "file-plus-2", "保存为笔记");
    saveButton.title = message.citations?.length ? "保存回答并保留引用来源" : "将回答保存为新笔记";
    saveButton.addEventListener("click", () => this.runAction(async () => {
      saveButton.disabled = true;
      try {
        if (message.citations?.length) await this.saveMessageWithCitations(message);
        else await this.createNoteFromMessage(message.content);
      } finally { saveButton.disabled = false; }
    }));

    const html = extractHtmlDocument(message.content);
    if (html) {
      const htmlButton = createIconButton(actions, "app-window", "保存 HTML 并预览", "ai-second-brain-artifact-action");
      let saved: TFile | undefined;
      htmlButton.addEventListener("click", () => {
        if (!this.plugin.settings.enableHtmlPreview) {
          new Notice("请先在插件设置中开启「启用 HTML 原生预览」。");
          this.openPluginSettings();
          return;
        }
        htmlButton.disabled = true;
        void (async () => {
          saved = saved || await saveHtmlArtifact(this.app, html);
          await this.plugin.openHtmlPreview(saved);
        })().catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : String(error));
        }).finally(() => { htmlButton.disabled = false; });
      });
    }

    const more = createIconButton(actions, "ellipsis", "更多操作", "ai-second-brain-message-more");
    more.addEventListener("click", event => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle("插入到光标").setIcon("corner-down-left").onClick(() => this.previewInsertAtCursor(message.content)));
      menu.addItem(item => item.setTitle("替换选区").setIcon("replace").onClick(() => this.previewReplaceSelection(message.content)));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("生成图谱").setIcon("workflow").onClick(() => {
        const view = this.plugin.getEditableMarkdownView();
        new GenerateDiagramModal(this.app, this.plugin, view?.editor, view?.file || undefined,
          message.content, message.citations).open();
      }));
      menu.addItem(item => item.setTitle("插入 Excalidraw 画布").setIcon("pencil-ruler")
        .onClick(() => this.runAction(() => this.submitDrawingEdit(message.content, undefined, true))));
      menu.addSeparator();

      menu.addItem(item => item.setTitle("创建修改计划").setIcon("files").onClick(() => {
        const session = this.plugin.getActiveChatSession();
        const filePaths = Array.from(new Set([
          ...(message.citations || []).map((citation) => citation.filePath),
          ...session.lastContextFilePaths,
          ...session.lockedFilePaths
        ]));
        if (filePaths.length === 0) {
          const activePath = this.plugin.getEditableMarkdownView()?.file?.path;
          if (activePath) filePaths.push(activePath);
        }
        if (filePaths.length === 0) {
          new Notice("当前回答没有可用于生成修改计划的笔记来源。");
          return;
        }
        new ModificationPlanModal(this.app, this.plugin, message.content, filePaths).open();
      }));
      menu.showAtMouseEvent(event);
    });
  }

  private renderCitations(container: HTMLElement, citations: Citation[], listKey: string): void {
    const citationsEl = container.createDiv({ cls: "ai-second-brain-citations" });
    const title = citationsEl.createDiv({ cls: "ai-second-brain-citations-title" });
    title.createSpan({ text: "引用来源" });
    title.createSpan({ cls: "ai-second-brain-citations-count", text: String(citations.length) });
    const isListExpanded = this.expandedCitationListKeys.has(listKey);
    const citationItems: HTMLElement[] = [];

    for (const [index, citation] of citations.entries()) {
      const citationKey = this.getCitationKey(citation);
      const isExpanded = this.expandedCitationKeys.has(citationKey);
      const item = citationsEl.createDiv({ cls: "ai-second-brain-citation" });
      citationItems.push(item);
      item.toggleClass("is-list-hidden", !isListExpanded && index >= COLLAPSED_CITATION_COUNT);
      item.toggleClass("is-expanded", isExpanded);

      const summary = item.createEl("button", {
        cls: "ai-second-brain-citation-summary",
        attr: { type: "button" }
      });
      const sourceIcon = summary.createSpan({ cls: "ai-second-brain-citation-icon" });
      setIcon(sourceIcon, "file-text");
      summary.createSpan({
        cls: `ai-second-brain-citation-evidence is-${citation.evidenceType || "related"}`,
        text: citation.evidenceType === "direct" ? "直接证据" : "相关资料"
      });
      summary.createSpan({
        cls: "ai-second-brain-citation-title",
        text: `${citation.title} · ${citation.startLine}-${citation.endLine}`
      });
      const toggleIcon = summary.createSpan({ cls: "ai-second-brain-citation-toggle" });
      setIcon(toggleIcon, isExpanded ? "chevron-up" : "chevron-down");
      summary.title = `${citation.filePath} · ${citation.startLine}-${citation.endLine}`;
      summary.setAttribute("aria-expanded", String(isExpanded));
      summary.addEventListener("click", () => {
        const scrollTop = this.messagesEl?.scrollTop;
        if (this.expandedCitationKeys.has(citationKey)) {
          this.expandedCitationKeys.delete(citationKey);
        } else {
          this.expandedCitationKeys.add(citationKey);
        }
        const expanded = this.expandedCitationKeys.has(citationKey);
        item.toggleClass("is-expanded", expanded);
        summary.setAttribute("aria-expanded", String(expanded));
        setIcon(toggleIcon, expanded ? "chevron-up" : "chevron-down");
        item.querySelector(".ai-second-brain-citation-detail")?.remove();
        if (expanded) {
          this.renderCitationDetail(item, citation);
        }
        if (this.messagesEl && scrollTop !== undefined) {
          this.messagesEl.scrollTop = scrollTop;
        }
      });
      void this.updateCitationFreshness(item, citation);

      if (isExpanded) {
        this.renderCitationDetail(item, citation);
      }
    }

    if (citations.length > COLLAPSED_CITATION_COUNT) {
      const hiddenCount = citations.length - COLLAPSED_CITATION_COUNT;
      const toggle = citationsEl.createEl("button", {
        cls: "ai-second-brain-citations-more",
        attr: { type: "button", "aria-expanded": String(isListExpanded) }
      });
      const label = toggle.createSpan();
      const icon = toggle.createSpan({ cls: "ai-second-brain-citations-more-icon" });
      const updateToggle = (expanded: boolean): void => {
        label.setText(expanded ? "收起引用" : `再显示 ${hiddenCount} 个文件`);
        setIcon(icon, expanded ? "chevron-up" : "chevron-down");
        toggle.setAttribute("aria-expanded", String(expanded));
      };
      updateToggle(isListExpanded);
      toggle.addEventListener("click", () => {
        const scrollTop = this.messagesEl?.scrollTop;
        const expanded = !this.expandedCitationListKeys.has(listKey);
        if (expanded) {
          this.expandedCitationListKeys.add(listKey);
        } else {
          this.expandedCitationListKeys.delete(listKey);
        }
        citationItems.forEach((item, index) => {
          item.toggleClass("is-list-hidden", !expanded && index >= COLLAPSED_CITATION_COUNT);
        });
        updateToggle(expanded);
        if (this.messagesEl && scrollTop !== undefined) {
          this.messagesEl.scrollTop = scrollTop;
        }
      });
    }
  }

  private renderCitationDetail(container: HTMLElement, citation: Citation): void {
    const detail = container.createDiv({ cls: "ai-second-brain-citation-detail" });
    detail.createDiv({ cls: "ai-second-brain-citation-path", text: citation.filePath });
    detail.createDiv({ cls: "ai-second-brain-citation-excerpt", text: citation.excerpt });
    const openButton = createIconButton(detail, "external-link", "打开来源", "ai-second-brain-citation-open");
    openButton.addEventListener("click", () => {
      void this.openCitation(citation);
    });
  }

  private async updateCitationFreshness(container: HTMLElement, citation: Citation): Promise<void> {
    if (!citation.sourceFingerprint) return;
    const file = this.app.vault.getAbstractFileByPath(citation.filePath);
    if (!(file instanceof TFile)) {
      container.addClass("is-stale");
      container.setAttribute("data-citation-status", "来源已不存在");
      return;
    }
    const cacheKey = `${citation.filePath}:${citation.startLine}-${citation.endLine}:${citation.sourceFingerprint}:${file.stat.mtime}:${file.stat.size}`;
    const cached = this.citationFreshnessCache.get(cacheKey);
    if (cached !== undefined) {
      if (!cached) {
        container.addClass("is-stale");
        container.setAttribute("data-citation-status", "来源可能已更新");
      }
      return;
    }
    const content = await this.app.vault.cachedRead(file);
    if (!container.isConnected) return;
    const lines = content.split(/\r?\n/).slice(Math.max(0, citation.startLine - 1), citation.endLine);
    const fresh = createCitationFingerprint(lines.join("\n")) === citation.sourceFingerprint;
    if (this.citationFreshnessCache.size >= 500) this.citationFreshnessCache.clear();
    this.citationFreshnessCache.set(cacheKey, fresh);
    if (!fresh) {
      container.addClass("is-stale");
      container.setAttribute("data-citation-status", "来源可能已更新");
    }
  }

  private enhanceInlineCitations(container: HTMLElement, citations: Citation[]): void {
    if (citations.length === 0) {
      return;
    }

    const ownerDocument = container.ownerDocument;
    const walker = ownerDocument.createTreeWalker(container, 4);
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      const parent = textNode.parentElement;
      if (
        parent &&
        /\[\d+\]/.test(textNode.data) &&
        !parent.closest("a, button, code, pre, .ai-second-brain-mermaid-artifact, .ai-second-brain-inline-citation")
      ) {
        textNodes.push(textNode);
      }
      node = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const fragment = ownerDocument.createDocumentFragment();
      const pattern = /\[(\d+)\]/g;
      let cursor = 0;
      let match: RegExpExecArray | null;
      let changed = false;

      while ((match = pattern.exec(textNode.data)) !== null) {
        const citation = citations[Number(match[1]) - 1];
        if (!citation) {
          continue;
        }
        changed = true;
        fragment.append(textNode.data.slice(cursor, match.index));
        fragment.appendChild(this.createInlineCitation(ownerDocument, citation, Number(match[1])));
        cursor = match.index + match[0].length;
      }

      if (changed) {
        fragment.append(textNode.data.slice(cursor));
        textNode.replaceWith(fragment);
      }
    }
  }

  private createInlineCitation(ownerDocument: Document, citation: Citation, index: number): HTMLButtonElement {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.className = "ai-second-brain-inline-citation";
    button.textContent = String(index);
    button.setAttribute("aria-label", `查看引用 ${index}：${citation.title}`);

    const preview = ownerDocument.createElement("span");
    preview.className = "ai-second-brain-inline-citation-preview";
    const title = ownerDocument.createElement("span");
    title.className = "ai-second-brain-inline-citation-preview-title";
    title.textContent = `${citation.title} · ${citation.startLine}-${citation.endLine}`;
    preview.appendChild(title);
    const path = ownerDocument.createElement("span");
    path.className = "ai-second-brain-inline-citation-preview-path";
    path.textContent = citation.filePath;
    preview.appendChild(path);
    const excerpt = ownerDocument.createElement("span");
    excerpt.className = "ai-second-brain-inline-citation-preview-excerpt";
    excerpt.textContent = citation.excerpt;
    preview.appendChild(excerpt);
    button.appendChild(preview);
    const positionPreview = (): void => {
      const viewport = ownerDocument.defaultView;
      if (!viewport) {
        return;
      }
      const anchor = button.getBoundingClientRect();
      const gap = 8;
      const width = Math.min(320, viewport.innerWidth - 20);
      preview.style.width = `${width}px`;
      preview.style.left = `${Math.max(10, Math.min(anchor.left + anchor.width / 2 - width / 2, viewport.innerWidth - width - 10))}px`;
      const previewHeight = Math.min(preview.scrollHeight, 240);
      const fitsAbove = anchor.top >= previewHeight + gap + 10;
      preview.style.top = fitsAbove
        ? `${anchor.top - previewHeight - gap}px`
        : `${anchor.bottom + gap}px`;
      preview.toggleClass("is-below", !fitsAbove);
    };
    button.addEventListener("pointerenter", positionPreview);
    button.addEventListener("focus", positionPreview);
    button.addEventListener("click", () => {
      void this.openCitation(citation);
    });
    return button;
  }

  private getCitationKey(citation: Citation): string {
    return `${citation.filePath}:${citation.startLine}-${citation.endLine}`;
  }

  private getCitationListKey(message: ViewChatMessage): string {
    return message.createdAt || `${message.citations?.[0]?.filePath || "citation"}:${message.content.length}`;
  }



  private async openCitation(citation: Citation): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(citation.filePath);

    if (!(file instanceof TFile)) {
      new Notice("找不到引用的笔记文件。");
      return;
    }

    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (!(leaf.view instanceof MarkdownView)) return;
    const editor = leaf.view.editor;
    const fromLine = Math.max(0, Math.min(citation.startLine - 1, editor.lineCount() - 1));
    const toLine = Math.max(fromLine, Math.min(citation.endLine - 1, editor.lineCount() - 1));
    const from = { line: fromLine, ch: 0 };
    const to = { line: toLine, ch: editor.getLine(toLine).length };
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    this.containerEl.ownerDocument.defaultView?.setTimeout(() => {
      const currentFrom = editor.getCursor("from");
      const currentTo = editor.getCursor("to");
      if (samePosition(currentFrom, from) && samePosition(currentTo, to)) editor.setCursor(to);
    }, 1800);
  }

  private async saveMessageWithCitations(message: ViewChatMessage): Promise<void> {
    const citations = message.citations || [];
    if (citations.length === 0) return;
    const content = buildFootnotedMessage(message.content, citations);
    try {
      const file = await this.plugin.createGeneratedNote("AI Answer with Sources", content);
      await this.app.workspace.getLeaf(false).openFile(file);
      new Notice("已保存带脚注引用的 AI 回答。");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private async openSelectionReference(reference: SelectionReference): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(reference.filePath);

    if (!(file instanceof TFile)) {
      new Notice("找不到这个选区对应的笔记。");
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const editor = view.editor;
      const from = { line: reference.fromLine, ch: reference.fromCh };
      const to = { line: reference.toLine, ch: reference.toCh };
      editor.setSelection(from, to);
      editor.scrollIntoView({ from, to }, true);
    }
  }

  private previewInsertAtCursor(content: string): void {
    const view = this.plugin.getEditableMarkdownView();
    const editor = view?.editor;

    if (!editor || !view.file) {
      new Notice("请先打开一个可编辑的 Markdown 笔记。");
      return;
    }

    const change = EditorChangeTransaction.captureInsertion(editor, view.file.path);

    new DiffPreviewModal(this.app, "", normalizeMermaidMarkdown(content), (value) => {
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

    new DiffPreviewModal(this.app, selection, normalizeMermaidMarkdown(content), (value) => {
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
      const file = await this.plugin.createGeneratedNote("AI Chat Result", normalizeMermaidMarkdown(content));
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`创建笔记失败：${message}`);
    }
  }

  private async copyMessage(content: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(normalizeMermaidMarkdown(content));
      new Notice("已复制 AI 回复。");
    } catch {
      new Notice("复制失败，请手动选择内容复制。");
    }
  }

  private async startNewSession(): Promise<void> {
    if (this.isGenerating || this.isPreparingContext) {
      new Notice("请先停止当前回答，再开始新对话。");
      return;
    }

    this.rememberCurrentDraft();
    this.setPreparingContext(true);
    try {
      this.resetDrawingState();
      await this.saveMessages();
      if (this.closed) return;
      const session = await this.plugin.createChatSession();
      if (this.closed) return;
      this.activeSessionId = session.id;
      this.messages = [];
      this.visibleMessageCount = 60;
      this.expandedCitationKeys.clear();
      this.expandedCitationListKeys.clear();
      this.refreshSessionControls();
      this.refreshScopeControls();
      this.renderMessages();
      this.restoreSessionDraft();
      this.renderPendingSelectionReferences();
    } catch (error) {
      new Notice(`创建对话失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { this.setPreparingContext(false); }
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

    if (this.isGenerating || this.isPreparingContext) {
      this.refreshSessionControls();
      new Notice("请先停止当前回答，再切换对话。");
      return;
    }

    this.rememberCurrentDraft();
    this.setPreparingContext(true);
    try {
      this.resetDrawingState();
      await this.saveMessages();
      if (this.closed) return;
      const session = await this.plugin.setActiveChatSession(sessionId);

      if (!session) {
        this.refreshSessionControls();
        new Notice("找不到该对话，它可能已被删除。");
        return;
      }

      this.activeSessionId = session.id;
      this.visibleMessageCount = 60;
      this.messages = session.messages.map(toViewMessage);
      this.expandedCitationKeys.clear();
      this.expandedCitationListKeys.clear();
      this.refreshSessionControls();
      this.refreshScopeControls();
      this.renderMessages();
      this.restoreSessionDraft();
      this.renderPendingSelectionReferences();
    } finally { this.setPreparingContext(false); }
  }

  private async clearMessages(): Promise<void> {
    if (this.isGenerating || this.isPreparingContext || this.messages.length === 0) return;
    const sessionId = this.activeSessionId;
    this.setPreparingContext(true);
    try {
      const confirmed = await confirmAction(this.app, "清空当前对话？", "此对话中的消息会被删除。已保存的笔记和页面不受影响。", "确认清空");
      if (!confirmed || this.closed || sessionId !== this.activeSessionId) return;
      await this.plugin.saveChatSessionMessages(sessionId, []);
      this.resetDrawingState();
      this.messages = [];
      this.visibleMessageCount = 60;
      this.expandedCitationKeys.clear();
      this.expandedCitationListKeys.clear();
      this.renderMessages();
      this.refreshSessionControls();
    } catch (error) { new Notice(`清空失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { this.setPreparingContext(false); }
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
          selectionReferences: message.selectionReferences,
          drawing: message.drawing,
          status: message.status === "streaming" ? "stopped" : message.status,
          createdAt: message.createdAt || new Date().toISOString()
        }))
    );
    this.refreshSessionControls();
  }

  private setGenerating(value: boolean): void {
    this.isGenerating = value;
    this.refreshBusyControls();
  }

  private setPreparingContext(value: boolean): void {
    this.isPreparingContext = value;
    this.refreshBusyControls();
  }

  private refreshBusyControls(): void {
    const busy = this.isGenerating || this.isPreparingContext;
    this.refreshDrawingContext();
    for (const button of [this.modelButtonEl, this.drawingButtonEl, this.sessionSwitcherButtonEl,
      this.scopePickerEl, this.newSessionButtonEl, this.sessionSettingsButtonEl]) {
      if (button) button.disabled = busy;
    }
    if (this.composer) this.composer.setBusy(this.isGenerating, this.isPreparingContext);
    else {
      if (this.inputEl) this.inputEl.disabled = busy;
      if (this.sendButtonEl) this.sendButtonEl.disabled = busy;
      if (this.stopButtonEl) this.stopButtonEl.style.display = this.isGenerating ? "" : "none";
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
    this.sessionSwitcherButtonEl.querySelector<HTMLElement>(".ai-second-brain-button-label")?.setText(label);
  }

  private runAction(action: () => Promise<unknown>): void {
    void action().catch(error => new Notice(error instanceof Error ? error.message : String(error)));
  }

  private openPluginSettings(): void {
    const settings = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (!settings) { new Notice("请在 Obsidian 设置中打开 AI Second Brain。"); return; }
    settings.open();
    settings.openTabById(this.plugin.manifest.id);
  }

  private refreshModelControls(): void {
    if (!this.modelButtonEl) return;
    const providers = (this.plugin.settings.providers || []).filter(provider => provider.enabled);
    const provider = providers.find(provider => provider.id === this.plugin.settings.defaultChatProviderId) || providers[0];
    const label = provider?.defaultModel || provider?.name || "配置模型";
    this.modelButtonEl.querySelector<HTMLElement>(".ai-second-brain-button-label")?.setText(label);
    this.modelButtonEl.title = provider ? `${provider.name} · ${provider.defaultModel}` : "配置 AI 服务商";
    this.modelButtonEl.setAttribute("aria-label", `选择模型：${this.modelButtonEl.title}`);
  }

  private openModelMenu(event: MouseEvent): void {
    if (this.isGenerating || this.isPreparingContext) return;
    const menu = new Menu();
    for (const provider of (this.plugin.settings.providers || []).filter(provider => provider.enabled)) {
      menu.addItem(item => item.setTitle(`${provider.name} · ${provider.defaultModel}`).setIcon(provider.type === "ollama" ? "hard-drive" : "cloud")
        .setChecked(provider.id === this.plugin.settings.defaultChatProviderId)
        .onClick(() => this.runAction(async () => {
          this.plugin.settings.defaultChatProviderId = provider.id;
          await this.plugin.saveSettings();
          this.refreshModelControls();
        })));
    }
    menu.addSeparator();
    menu.addItem(item => item.setTitle("配置 AI 服务商").setIcon("settings-2").onClick(() => this.openPluginSettings()));
    menu.showAtMouseEvent(event);
  }

  private openToolsMenu(event: MouseEvent): void {
    if (this.isGenerating || this.isPreparingContext) return;
    const menu = new Menu();
    menu.addItem(item => item.setTitle("当前对话设置").setIcon("settings-2").onClick(() => this.runAction(() => this.editCurrentSession())));
    menu.addSeparator();
    menu.addItem(item => item.setTitle("AI 修改授权笔记").setIcon("files")
      .onClick(() => new FileAgentModal(this.app, this.plugin).open()));
    menu.addItem(item => item.setTitle("生成笔记内容").setIcon("wand-sparkles")
      .onClick(() => new GenerateContentModal(this.app, this.plugin, this.plugin.getEditableMarkdownView()?.editor).open()));
    menu.addItem(item => item.setTitle("生成图谱").setIcon("workflow").onClick(() => {
      const view = this.plugin.getEditableMarkdownView();
      new GenerateDiagramModal(this.app, this.plugin, view?.editor, view?.file || undefined).open();
    }));
    menu.addItem(item => item.setTitle("知识库健康检查").setIcon("activity").onClick(() => this.runAction(() => this.plugin.openKnowledgeHealthReport())));
    menu.addItem(item => item.setTitle("生成 MOC 草稿").setIcon("network").onClick(() => this.runAction(() => this.plugin.draftManager.createMocDraft())));
    menu.addItem(item => item.setTitle("撤销上次笔记修改").setIcon("undo-2")
      .setDisabled(!this.plugin.modificationService?.canUndo())
      .onClick(() => this.runAction(async () => {
        const count = await this.plugin.modificationService.undoLastBatch();
        new Notice(`已撤销 ${count} 项笔记修改。`);
      })));
    menu.addSeparator();
    menu.addItem(item => item.setTitle("清空当前对话").setIcon("trash-2").onClick(() => this.runAction(() => this.clearMessages())));
    menu.showAtMouseEvent(event);
  }

  private openSessionSwitcher(): void {
    if (this.isGenerating || this.isPreparingContext) {
      return;
    }

    new ChatSessionManagerModal(this.app, this.plugin, {
      onSelect: (sessionId) => this.switchSession(sessionId),
      onDelete: (deletedIds, activeSessionId) => this.handleDeletedSessions(deletedIds, activeSessionId)
    }).open();
  }

  private async handleDeletedSessions(deletedIds: string[], activeSessionId: string): Promise<void> {
    for (const sessionId of deletedIds) this.sessionDrafts.delete(sessionId);
    if (!deletedIds.includes(this.activeSessionId)) {
      this.refreshSessionControls();
      return;
    }
    const session = this.plugin.settings.chatSessions.find((item) => item.id === activeSessionId);
    if (!session) return;
    this.resetDrawingState();
    this.activeSessionId = session.id;
    this.messages = session.messages.map(toViewMessage);
    this.expandedCitationKeys.clear();
    this.expandedCitationListKeys.clear();
    this.refreshSessionControls();
    this.refreshScopeControls();
    this.renderMessages();
    this.restoreSessionDraft();
    this.renderPendingSelectionReferences();
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
      this.composer?.refresh();
    }
  }

  private clearMessageRenderComponents(): void {
    this.messagesEl?.querySelectorAll<HTMLElement>(".ai-second-brain-mermaid-artifact")
      .forEach(artifact => artifact.dispatchEvent(new Event("ai-second-brain-dispose")));
    this.historyAnchor?.release();
    this.cancelStreamingTimer();
    this.pendingStreamingMessage = undefined;

    for (const component of this.messageRenderComponents) {
      this.removeChild(component);
    }

    this.messageRenderComponents = [];
  }

  private canRender(): boolean {
    return !this.closed && this.viewVisible && !this.containerEl.ownerDocument.hidden;
  }

  private updateRenderVisibility(): void {
    if (this.closed) return;
    if (!this.canRender()) { this.cancelStreamingTimer(); return; }
    if (this.pendingFullRender) this.renderMessages(this.pendingFollowOutput);
    else if (this.pendingStreamingMessage) this.scheduleLastMessageContentUpdate(this.pendingStreamingMessage);
    this.historyAnchor?.restore();
  }

  private cancelStreamingTimer(): void {
    const ownerWindow = this.containerEl.ownerDocument.defaultView;
    if (this.streamingRenderTimer !== undefined && ownerWindow) {
      ownerWindow.clearTimeout(this.streamingRenderTimer);
    }
    this.streamingRenderTimer = undefined;
  }

  private renderPendingSelectionReferences(): void {
    if (!this.selectionReferencesEl) {
      return;
    }

    const references = this.plugin.getPendingSelectionReferences(this.activeSessionId);
    this.selectionReferencesEl.empty();
    this.selectionReferencesEl.toggleClass("is-visible", references.length > 0);

    if (references.length === 0) {
      return;
    }

    const header = this.selectionReferencesEl.createDiv({ cls: "ai-second-brain-composer-references-header" });
    const headerLabel = header.createDiv({ cls: "ai-second-brain-composer-references-title" });
    const headerIcon = headerLabel.createSpan({ cls: "ai-second-brain-composer-references-title-icon" });
    setIcon(headerIcon, "text-quote");
    headerLabel.createSpan({ text: "对话引用" });
    headerLabel.createSpan({
      cls: "ai-second-brain-composer-references-count",
      text: String(references.length)
    });
    const clearButton = createIconButton(header, "x", "清空全部引用", "ai-second-brain-composer-references-clear");
    clearButton.addEventListener("click", () => {
      this.plugin.clearPendingSelectionReferences(this.activeSessionId);
    });

    const list = this.selectionReferencesEl.createDiv({ cls: "ai-second-brain-composer-reference-list" });
    const groups = groupSelectionReferences(references);
    for (const group of groups) {
      const groupEl = list.createDiv({ cls: "ai-second-brain-composer-reference-group" });
      const groupHeader = groupEl.createDiv({ cls: "ai-second-brain-composer-reference-group-header" });
      const fileIcon = groupHeader.createSpan({ cls: "ai-second-brain-composer-reference-file-icon" });
      setIcon(fileIcon, "file-text");
      groupHeader.createSpan({
        cls: "ai-second-brain-composer-reference-file-name",
        text: group.fileName
      });
      groupHeader.createSpan({
        cls: "ai-second-brain-composer-reference-file-count",
        text: `${group.references.length} 处`
      });

      for (const reference of group.references) {
        const row = groupEl.createDiv({ cls: "ai-second-brain-composer-reference" });
        const openButton = row.createEl("button", {
          cls: "ai-second-brain-composer-reference-open",
          attr: {
            type: "button",
            title: reference.text
          }
        });
        openButton.createSpan({
          cls: "ai-second-brain-composer-reference-line",
          text: formatLineRange(reference)
        });
        openButton.createSpan({
          cls: "ai-second-brain-composer-reference-excerpt",
          text: compactReferenceText(reference.text)
        });
        openButton.addEventListener("click", () => {
          void this.openSelectionReference(reference);
        });
        const removeButton = createIconButton(row, "x", "移除此引用", "ai-second-brain-composer-reference-remove");
        removeButton.addEventListener("click", () => {
          this.plugin.removePendingSelectionReference(this.activeSessionId, reference.id);
        });
      }
    }
  }

  private refreshScopeControls(): void {
    if (!this.scopePickerEl || !this.scopeIconEl || !this.scopeLabelEl) {
      return;
    }

    const selectedScope = this.plugin.getActiveContextScope();
    const files = this.plugin.contextScopeResolver.resolve(selectedScope);
    const label = selectedScope ? formatScopeSelection(selectedScope, files) : "选择文件或文件夹";
    const session = this.plugin.getActiveChatSession();
    setIcon(this.scopeIconEl, getContextModeIcon(session.contextMode, selectedScope));
    this.scopeLabelEl.setText(selectedScope?.allowCloudModels === false ? `${label} · 仅本地` : label);
    const description = `${contextModeLabel(session.contextMode)} · ${label} · ${files.length} 个文件 · ${selectedScope?.allowCloudModels === false ? "仅允许本地模型" : "允许云端模型"}`;
    this.scopePickerEl.title = description;
    this.scopePickerEl.setAttribute("aria-label", `选择 AI 可访问的文件或文件夹：${description}`);
  }

  private openContextModeMenu(event: MouseEvent): void {
    if (this.isGenerating || this.isPreparingContext) {
      return;
    }

    const session = this.plugin.getActiveChatSession();
    const menu = new Menu();
    this.addContextModeMenuItem(menu, "follow", "scan-line", "跟随当前文件", session.contextMode);
    this.addContextModeMenuItem(menu, "locked", "lock-keyhole", "锁定此文件", session.contextMode);
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("手动选择文件或文件夹")
        .setIcon("folder-search")
        .setChecked(session.contextMode === "manual")
        .onClick(() => {
          void this.openContextSourcePicker();
        });
    });
    const savedScopes = (this.plugin.settings.contextScopes || []).filter(scope => scope.id !== "current-file");
    if (savedScopes.length > 0) {
      menu.addSeparator();
      for (const scope of savedScopes) {
        menu.addItem(item => item.setTitle(`范围 · ${scope.name}`).setIcon(getScopeIcon(scope))
          .setChecked(session.contextMode === "manual" && !session.contextScopeOverride && session.contextScopeId === scope.id)
          .onClick(() => this.runAction(() => this.plugin.setActiveContextScope(scope.id))));
      }
    }
    menu.addSeparator();
    menu.addItem(item => item.setTitle("查看已授权文件").setIcon("shield-check").onClick(() => {
      const scope = this.plugin.getActiveContextScope();
      new AuthorizedFilesModal(this.app, scope?.name || "当前范围", this.plugin.contextScopeResolver.resolve(scope)).open();
    }));
    menu.addItem(item => item.setTitle("重新选择本次参考文件").setIcon("list-checks").onClick(() => this.runAction(async () => {
      session.autoContext = true;
      session.lastContextFingerprint = "";
      session.lastContextFilePaths = [];
      await this.plugin.saveSettings();
      new Notice("下次发送前会重新确认参考文件。");
    })));
    menu.showAtMouseEvent(event);
  }

  private addContextModeMenuItem(
    menu: Menu,
    mode: ChatContextMode,
    icon: string,
    label: string,
    currentMode: ChatContextMode
  ): void {
    menu.addItem((item) => {
      item
        .setTitle(label)
        .setIcon(icon)
        .setChecked(mode === currentMode)
        .onClick(() => {
          if (mode === "follow" && !this.plugin.settings.autoRecognizeActiveFile) {
            this.plugin.settings.autoRecognizeActiveFile = true;
          }
          void this.plugin.setChatSessionContextMode(this.activeSessionId, mode);
        });
    });
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
    return files[0]?.name || "未打开可用文件";
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

export function toViewMessage(message: StoredChatMessage): ViewChatMessage {
  return {
    role: message.role,
    content: message.role === "assistant" ? normalizeMermaidMarkdown(message.content) : message.content,
    citations: message.citations,
    selectionReferences: message.selectionReferences,
    isComplete: true,
    status: message.status || "complete",
    createdAt: message.createdAt,
    drawing: message.drawing ? { ...message.drawing, state: message.drawing.state === "preview" ? "expired" : message.drawing.state } : undefined
  };
}

export function toProviderHistory(messages: ViewChatMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.content.trim() && message.status === "complete" && (!message.drawing || message.drawing.state === "applied"))
    .map((message) => ({
      role: message.role,
      content: appendSelectionReferences(message.content, message.selectionReferences || [])
    }));
}

function appendSelectionReferences(content: string, references: SelectionReference[]): string {
  if (references.length === 0) {
    return content;
  }

  const blocks = references.map((reference, index) => [
    `引用选区 ${index + 1}：${reference.filePath} · ${formatLineRange(reference)}`,
    "```markdown",
    reference.text,
    "```"
  ].join("\n"));
  return `${content}\n\n以下是用户明确添加到本轮对话的原文选区：\n\n${blocks.join("\n\n")}`;
}

function formatLineRange(reference: SelectionReference): string {
  const start = reference.fromLine + 1;
  const end = reference.toLine + 1;
  return start === end ? `第 ${start} 行` : `第 ${start}–${end} 行`;
}

function groupSelectionReferences(
  references: SelectionReference[]
): Array<{ filePath: string; fileName: string; references: SelectionReference[] }> {
  const groups = new Map<string, { filePath: string; fileName: string; references: SelectionReference[] }>();

  for (const reference of references) {
    const group = groups.get(reference.filePath);
    if (group) {
      group.references.push(reference);
    } else {
      groups.set(reference.filePath, {
        filePath: reference.filePath,
        fileName: reference.fileName,
        references: [reference]
      });
    }
  }

  return Array.from(groups.values());
}

function compactReferenceText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 52 ? `${compact.slice(0, 52)}…` : compact;
}

function contextModeLabel(mode: ChatContextMode): string {
  if (mode === "follow") {
    return "跟随当前文件";
  }
  if (mode === "locked") {
    return "已锁定";
  }
  return "手动上下文";
}

function getContextModeIcon(mode: ChatContextMode, scope: ContextScope | undefined): string {
  if (mode === "follow") {
    return "scan-line";
  }
  if (mode === "locked") {
    return "lock-keyhole";
  }
  return getScopeIcon(scope);
}

function isNearScrollBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 72;
}

function samePosition(a: { line: number; ch: number }, b: { line: number; ch: number }): boolean {
  return a.line === b.line && a.ch === b.ch;
}

function buildFootnotedMessage(content: string, citations: Citation[]): string {
  const segments = content.split(/(```[\s\S]*?```)/g);
  const body = segments.map((segment, index) => index % 2 === 1 ? segment : segment.replace(/\[(\d+)\]/g, (match, value) => {
    const citationIndex = Number(value) - 1;
    return citations[citationIndex] ? `[^${value}]` : match;
  })).join("");
  const footnotes = citations.map((citation, index) => {
    const target = citation.filePath.replace(/\.md$/i, "");
    const excerpt = citation.excerpt.replace(/\s+/g, " ").trim();
    const evidence = citation.evidenceType === "direct" ? "直接证据" : "相关资料";
    return `[^${index + 1}]: [[${target}|${citation.title}]]，第 ${citation.startLine}-${citation.endLine} 行，${evidence}。${excerpt}`;
  });
  return [`# AI 回答`, "", body.trim(), "", "## 引用来源", "", ...footnotes, ""].join("\n");
}

function createContextFingerprint(
  session: StoredChatSession,
  scope: ContextScope | undefined,
  files: TFile[],
  lockedFilePaths: string[] = session.lockedFilePaths
): string {
  const signature = [
    session.contextMode,
    scope?.id || "no-scope",
    ...files.map((file) => file.path).sort(),
    "--locked--",
    ...lockedFilePaths.slice().sort()
  ].join("\n");
  let hash = 2166136261;
  for (let index = 0; index < signature.length; index += 1) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `context-v1-${(hash >>> 0).toString(36)}-${files.length}-${lockedFilePaths.length}`;
}
