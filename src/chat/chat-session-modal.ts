import { App, Modal, setIcon, Setting } from "obsidian";
import { ContextScope } from "../context/scope-types";
import { createIconButton } from "../ui/icon-button";
import { ChatSessionConfig, StoredChatSession } from "./types";

type ChatSessionModalOptions = {
  mode: "create" | "edit";
  scopes: ContextScope[];
  session?: StoredChatSession;
  defaultScopeId: string;
};

export function configureChatSession(
  app: App,
  options: ChatSessionModalOptions
): Promise<ChatSessionConfig | undefined> {
  return new Promise((resolve) => {
    new ChatSessionModal(app, options, resolve).open();
  });
}

class ChatSessionModal extends Modal {
  private title: string;
  private purpose: string;
  private contextScopeId: string;
  private contextMode: ChatSessionConfig["contextMode"];
  private autoContext: boolean;
  private lockedFilePaths: string[];
  private settled = false;

  constructor(
    app: App,
    private readonly options: ChatSessionModalOptions,
    private readonly resolveResult: (result: ChatSessionConfig | undefined) => void
  ) {
    super(app);
    this.title = options.session?.title === "新对话" ? "" : options.session?.title || "";
    this.purpose = options.session?.purpose || "";
    this.contextScopeId = options.session?.contextScopeId || options.defaultScopeId;
    this.contextMode = options.session?.contextMode || (this.contextScopeId === "current-file" ? "follow" : "manual");
    this.autoContext = options.session?.autoContext ?? true;
    this.lockedFilePaths = [...(options.session?.lockedFilePaths || [])];
  }

  onOpen(): void {
    this.contentEl.addClass("ai-second-brain-session-modal");
    this.modalEl.addClass("ai-second-brain-session-modal-shell");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const header = contentEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "messages-square");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: this.options.mode === "create" ? "创建新对话" : "对话设置" });
    heading.createEl("p", {
      cls: "ai-second-brain-muted",
      text: "为这段对话设置独立目标与知识范围"
    });

    const scroll = contentEl.createDiv({ cls: "ai-second-brain-session-scroll" });
    const identity = this.createSection(scroll, "对话身份", "用于在对话列表中识别，并持续约束 AI 的回答方式。", "badge-info");
    new Setting(identity)
      .setName("对话名称")
      .setDesc("简短、明确，方便之后快速切换")
      .addText((text) => {
        text.setPlaceholder("例如：产品研究").setValue(this.title).onChange((value) => {
          this.title = value.trim();
        });
      });

    new Setting(identity)
      .setName("助手职责")
      .setDesc("可留空；填写后会作为本对话的固定工作原则")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setPlaceholder("例如：分析项目风险，优先引用会议记录，区分事实与建议。")
          .setValue(this.purpose)
          .onChange((value) => {
            this.purpose = value.trim();
          });
      });

    const context = this.createSection(scroll, "知识范围", "决定每轮对话从哪些笔记中检索内容。", "folder-search");
    const mode = context.createDiv({ cls: "ai-second-brain-session-mode" });
    const modes: Array<{
      value: ChatSessionConfig["contextMode"];
      icon: string;
      label: string;
      description: string;
    }> = [
      { value: "follow", icon: "scan-line", label: "跟随", description: "切换笔记时同步" },
      { value: "locked", icon: "lock-keyhole", label: "锁定", description: "固定当前笔记" },
      { value: "manual", icon: "folder-lock", label: "手动", description: "使用授权范围" }
    ];
    for (const option of modes) {
      const button = mode.createEl("button", {
        cls: "ai-second-brain-session-mode-option",
        attr: { type: "button", "aria-pressed": String(this.contextMode === option.value) }
      });
      button.toggleClass("is-active", this.contextMode === option.value);
      const optionIcon = button.createSpan({ cls: "ai-second-brain-session-mode-icon" });
      setIcon(optionIcon, option.icon);
      const optionCopy = button.createSpan({ cls: "ai-second-brain-session-mode-copy" });
      optionCopy.createSpan({ cls: "ai-second-brain-session-mode-label", text: option.label });
      optionCopy.createSpan({ cls: "ai-second-brain-session-mode-description", text: option.description });
      button.addEventListener("click", () => {
        this.contextMode = option.value;
        this.render();
      });
    }

    const form = context.createDiv({ cls: "ai-second-brain-session-form" });
    new Setting(form)
      .setName("授权范围")
      .setDesc(this.contextMode === "manual" ? "从该范围自动检索相关笔记" : "作为文件访问和云端发送的安全边界")
      .addDropdown((dropdown) => {
        for (const scope of this.options.scopes) {
          dropdown.addOption(scope.id, scope.name);
        }
        dropdown.setValue(this.contextScopeId).onChange((value) => {
          this.contextScopeId = value;
          this.lockedFilePaths = [];
          this.render();
        });
      });

    new Setting(form)
      .setName("智能选择上下文")
      .setDesc("先检索最相关笔记；首次使用或范围变化时由你确认")
      .addToggle((toggle) => {
        toggle.setValue(this.autoContext).onChange((value) => {
          this.autoContext = value;
        });
      });

    if (this.lockedFilePaths.length > 0) {
      const locked = context.createDiv({ cls: "ai-second-brain-session-locked" });
      const lockedIcon = locked.createDiv({ cls: "ai-second-brain-session-locked-icon" });
      setIcon(lockedIcon, "pin");
      const lockedCopy = locked.createDiv({ cls: "ai-second-brain-session-locked-copy" });
      lockedCopy.createDiv({ cls: "ai-second-brain-session-locked-title", text: `${this.lockedFilePaths.length} 个锁定文件` });
      lockedCopy.createDiv({ cls: "ai-second-brain-session-locked-description", text: "这些文件会固定进入每轮上下文。" });
      const clear = createIconButton(locked, "pin-off", "清除锁定", "ai-second-brain-session-locked-clear");
      clear.addEventListener("click", () => {
        this.lockedFilePaths = [];
        this.render();
      });
    }

    const actions = contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancelButton = createIconButton(actions, "x", "取消");
    cancelButton.addEventListener("click", () => this.close());
    const saveButton = createIconButton(
      actions,
      this.options.mode === "create" ? "plus" : "check",
      this.options.mode === "create" ? "创建对话" : "保存",
      "mod-cta"
    );
    saveButton.addEventListener("click", () => {
      this.settled = true;
      this.resolveResult({
        title: this.title || "新对话",
        purpose: this.purpose,
        contextScopeId: this.contextScopeId,
        contextMode: this.contextMode,
        autoContext: this.autoContext,
        lockedFilePaths: this.lockedFilePaths
      });
      this.close();
    });
  }

  private createSection(container: HTMLElement, title: string, description: string, iconName: string): HTMLElement {
    const section = container.createDiv({ cls: "ai-second-brain-session-section" });
    const header = section.createDiv({ cls: "ai-second-brain-session-section-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-session-section-icon" });
    setIcon(icon, iconName);
    const copy = header.createDiv({ cls: "ai-second-brain-session-section-copy" });
    copy.createDiv({ cls: "ai-second-brain-session-section-title", text: title });
    copy.createDiv({ cls: "ai-second-brain-session-section-description", text: description });
    return section;
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(undefined);
    }
    this.contentEl.empty();
  }
}
