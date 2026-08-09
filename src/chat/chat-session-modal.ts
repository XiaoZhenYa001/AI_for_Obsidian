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
    heading.createEl("h2", { text: this.options.mode === "create" ? "创建独立对话" : "对话设置" });
    heading.createEl("p", {
      cls: "ai-second-brain-muted",
      text: "每个对话独立保存职责、授权范围和锁定文件"
    });

    const form = contentEl.createDiv({ cls: "ai-second-brain-session-form" });
    new Setting(form)
      .setName("对话名称")
      .setDesc("例如：产品研究、项目周报或论文助手")
      .addText((text) => {
        text.setPlaceholder("新对话").setValue(this.title).onChange((value) => {
          this.title = value.trim();
        });
      });

    new Setting(form)
      .setName("助手职责")
      .setDesc("这段说明会作为本对话的固定系统职责")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.setPlaceholder("例如：只分析项目风险，优先引用会议记录，不替我做未经确认的决定。")
          .setValue(this.purpose)
          .onChange((value) => {
            this.purpose = value.trim();
          });
      });

    new Setting(form)
      .setName("文件识别方式")
      .setDesc("跟随活动文件、锁定当前文件，或使用手动授权范围")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("follow", "跟随当前文件")
          .addOption("locked", "锁定当前文件")
          .addOption("manual", "手动上下文")
          .setValue(this.contextMode)
          .onChange((value) => {
            this.contextMode = value as ChatSessionConfig["contextMode"];
          });
      });

    new Setting(form)
      .setName("授权范围")
      .setDesc("自动检索和锁定文件都不会越过该范围")
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
      .setName("自动选择并确认上下文")
      .setDesc("首次使用或文件范围变化时允许调整，之后持续复用确认结果")
      .addToggle((toggle) => {
        toggle.setValue(this.autoContext).onChange((value) => {
          this.autoContext = value;
        });
      });

    if (this.lockedFilePaths.length > 0) {
      new Setting(form)
        .setName("锁定文件")
        .setDesc(`${this.lockedFilePaths.length} 个文件会固定进入每轮上下文`)
        .addExtraButton((button) => {
          button.setIcon("pin-off").setTooltip("清除全部锁定").onClick(() => {
            this.lockedFilePaths = [];
            this.render();
          });
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

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(undefined);
    }
    this.contentEl.empty();
  }
}
