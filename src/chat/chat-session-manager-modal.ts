import { App, Modal, Notice, setIcon } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { createIconButton } from "../ui/icon-button";
import type { StoredChatSession } from "./types";

type SessionManagerCallbacks = {
  onSelect: (sessionId: string) => Promise<void>;
  onDelete: (deletedIds: string[], activeSessionId: string) => Promise<void>;
};

export class ChatSessionManagerModal extends Modal {
  private query = "";
  private selectionMode = false;
  private selected = new Set<string>();
  private pendingDeleteId?: string;
  private batchConfirming = false;
  private listEl?: HTMLElement;
  private footerEl?: HTMLElement;
  private searchInput?: HTMLInputElement;
  private showArchived = false;

  constructor(
    app: App,
    private readonly plugin: ObsidianAIPlugin,
    private readonly callbacks: SessionManagerCallbacks
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ai-second-brain-session-manager-shell");
    this.contentEl.addClass("ai-second-brain-session-manager");

    const header = this.contentEl.createDiv({ cls: "ai-second-brain-session-manager-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "messages-square");
    const copy = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    copy.createEl("h2", { text: "切换对话" });
    copy.createEl("p", { text: `${this.plugin.settings.chatSessions.length} 个独立对话与上下文` });
    const manage = createIconButton(header, "list-checks", "批量管理", "ai-second-brain-session-manager-manage");
    manage.addEventListener("click", () => {
      this.selectionMode = !this.selectionMode;
      this.selected.clear();
      this.pendingDeleteId = undefined;
      this.batchConfirming = false;
      manage.toggleClass("is-active", this.selectionMode);
      this.renderList();
      this.renderFooter();
    });

    const search = this.contentEl.createDiv({ cls: "ai-second-brain-session-manager-search" });
    const searchIcon = search.createSpan();
    setIcon(searchIcon, "search");
    this.searchInput = search.createEl("input", {
      type: "search",
      placeholder: "搜索对话",
      attr: { "aria-label": "搜索对话" }
    });
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput?.value.trim().toLowerCase() || "";
      this.renderList();
    });
    const archived = createIconButton(search, "archive", "显示已归档对话");
    archived.addEventListener("click", () => {
      this.showArchived = !this.showArchived;
      this.selected.clear();
      archived.toggleClass("is-active", this.showArchived);
      archived.setAttribute("aria-pressed", String(this.showArchived));
      this.renderList();
      this.renderFooter();
    });

    this.listEl = this.contentEl.createDiv({ cls: "ai-second-brain-session-manager-list" });
    this.footerEl = this.contentEl.createDiv({ cls: "ai-second-brain-session-manager-footer" });
    this.renderList();
    this.renderFooter();
    window.setTimeout(() => this.searchInput?.focus(), 0);
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const sessions = this.plugin.settings.chatSessions.filter((session) => {
      if (Boolean(session.archived) !== this.showArchived) return false;
      if (!this.query) return true;
      return `${session.title} ${session.purpose}`.toLowerCase().includes(this.query);
    });
    if (sessions.length === 0) {
      const empty = this.listEl.createDiv({ cls: "ai-second-brain-session-manager-empty" });
      const icon = empty.createDiv();
      setIcon(icon, "message-square-dashed");
      empty.createDiv({ text: "没有匹配的对话" });
      return;
    }

    for (const session of sessions) this.renderSession(session);
  }

  private renderSession(session: StoredChatSession): void {
    if (!this.listEl) return;
    const isActive = session.id === this.plugin.settings.activeChatSessionId;
    const isConfirming = this.pendingDeleteId === session.id;
    const item = this.listEl.createDiv({ cls: "ai-second-brain-session-manager-item" });
    item.toggleClass("is-active", isActive);
    item.toggleClass("is-selected", this.selected.has(session.id));
    item.toggleClass("is-confirming", isConfirming);

    if (this.selectionMode) {
      const checkbox = item.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selected.has(session.id);
      checkbox.setAttribute("aria-label", `选择 ${session.title}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(session.id); else this.selected.delete(session.id);
        item.toggleClass("is-selected", checkbox.checked);
        this.batchConfirming = false;
        this.renderFooter();
      });
    } else {
      const icon = item.createDiv({ cls: "ai-second-brain-session-manager-item-icon" });
      setIcon(icon, isActive ? "message-square-dot" : "message-square");
    }

    const main = item.createEl("button", {
      cls: "ai-second-brain-session-manager-item-main",
      attr: { type: "button" }
    });
    const titleRow = main.createDiv({ cls: "ai-second-brain-session-manager-title-row" });
    titleRow.createSpan({ cls: "ai-second-brain-session-manager-title", text: session.title });
    if (isActive) titleRow.createSpan({ cls: "ai-second-brain-session-manager-current", text: "当前" });
    main.createDiv({
      cls: "ai-second-brain-session-manager-meta",
      text: `${contextModeLabel(session)} · ${session.messages.length} 条消息 · ${formatRelativeTime(session.updatedAt)}`
    });
    if (session.purpose) {
      main.createDiv({ cls: "ai-second-brain-session-manager-purpose", text: session.purpose });
    }
    main.addEventListener("click", () => {
      if (this.selectionMode) {
        if (this.selected.has(session.id)) this.selected.delete(session.id); else this.selected.add(session.id);
        this.renderList();
        this.renderFooter();
        return;
      }
      if (isConfirming) return;
      void this.callbacks.onSelect(session.id).then(() => this.close());
    });

    if (this.selectionMode) return;
    const action = item.createDiv({ cls: "ai-second-brain-session-manager-item-action" });
    const archive = createIconButton(action, session.archived ? "archive-restore" : "archive", session.archived ? "恢复对话" : "归档对话");
    archive.addEventListener("click", () => {
      void this.plugin.setChatSessionArchived(session.id, !session.archived).then(() => this.renderList()).catch((error: unknown) => {
        new Notice(error instanceof Error ? error.message : String(error));
      });
    });
    if (isConfirming) {
      const cancel = createIconButton(action, "undo-2", "取消删除", "ai-second-brain-session-delete-cancel");
      cancel.addEventListener("click", () => {
        this.pendingDeleteId = undefined;
        this.renderList();
      });
      const confirm = createIconButton(action, "trash-2", "确认删除", "ai-second-brain-session-delete-confirm");
      confirm.addEventListener("click", () => void this.deleteSessions([session.id]));
    } else {
      const remove = createIconButton(action, "x", "删除对话", "ai-second-brain-session-delete");
      remove.addEventListener("click", () => {
        this.pendingDeleteId = session.id;
        this.renderList();
      });
    }
  }

  private renderFooter(): void {
    if (!this.footerEl) return;
    this.footerEl.empty();
    if (!this.selectionMode) {
      this.footerEl.createSpan({ text: "点击对话即可切换" });
      return;
    }

    const selection = this.footerEl.createDiv({ cls: "ai-second-brain-session-manager-selection" });
    const selectAll = selection.createEl("button", { text: "全选", attr: { type: "button" } });
    selectAll.addEventListener("click", () => {
      this.selected = new Set(this.plugin.settings.chatSessions.filter((session) =>
        Boolean(session.archived) === this.showArchived &&
        (!this.query || `${session.title} ${session.purpose}`.toLowerCase().includes(this.query))
      ).map((session) => session.id));
      this.batchConfirming = false;
      this.renderList();
      this.renderFooter();
    });
    selection.createSpan({ text: `已选择 ${this.selected.size} 个` });

    const actions = this.footerEl.createDiv({ cls: "ai-second-brain-session-manager-batch-actions" });
    if (this.batchConfirming) {
      actions.createSpan({ text: `确认删除 ${this.selected.size} 个对话？` });
      const cancel = createIconButton(actions, "x", "取消");
      cancel.addEventListener("click", () => {
        this.batchConfirming = false;
        this.renderFooter();
      });
      const confirm = createIconButton(actions, "trash-2", "确认删除", "mod-warning");
      confirm.addEventListener("click", () => void this.deleteSessions(Array.from(this.selected)));
    } else {
      const remove = createIconButton(actions, "trash-2", "删除所选");
      remove.disabled = this.selected.size === 0;
      remove.addEventListener("click", () => {
        this.batchConfirming = true;
        this.renderFooter();
      });
    }
  }

  private async deleteSessions(ids: string[]): Promise<void> {
    try {
      const active = await this.plugin.deleteChatSessions(ids);
      await this.callbacks.onDelete(ids, active.id);
      this.selected.clear();
      this.pendingDeleteId = undefined;
      this.batchConfirming = false;
      this.query = "";
      if (this.searchInput) this.searchInput.value = "";
      this.renderList();
      this.renderFooter();
      new Notice(ids.length === 1 ? "对话已删除。" : `已删除 ${ids.length} 个对话。`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
}

function contextModeLabel(session: StoredChatSession): string {
  return session.contextMode === "follow" ? "跟随文件" : session.contextMode === "locked" ? "锁定文件" : "手动范围";
}

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "未知时间";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} 天前` : new Date(value).toLocaleDateString();
}
