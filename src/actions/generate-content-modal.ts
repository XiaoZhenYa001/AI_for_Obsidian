import { App, Component, Editor, MarkdownRenderer, Modal, Notice, setIcon, Setting } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { Citation } from "../retrieval/types";
import { createIconButton } from "../ui/icon-button";
import { EditorChangeTransaction } from "./editor-change-transaction";

type OutputTarget = "insert" | "new-note";

export class GenerateContentModal extends Modal {
  private prompt = "";
  private noteTitle = "";
  private outputTarget: OutputTarget;
  private useContext = true;
  private generatedContent = "";
  private citations: Citation[] = [];
  private previewEl?: HTMLElement;
  private citationsEl?: HTMLElement;
  private previewStatusEl?: HTMLElement;
  private generateButtonEl?: HTMLButtonElement;
  private insertButtonEl?: HTMLButtonElement;
  private newNoteButtonEl?: HTMLButtonElement;
  private insertionTarget?: EditorChangeTransaction;
  private previewRenderComponent?: Component;

  constructor(
    app: App,
    private readonly plugin: ObsidianAIPlugin,
    private readonly editor?: Editor
  ) {
    super(app);
    this.outputTarget = editor ? "insert" : "new-note";
    const activeFile = editor ? plugin.getMarkdownViewForEditor(editor)?.file : undefined;

    if (editor && activeFile) {
      this.insertionTarget = EditorChangeTransaction.captureInsertion(editor, activeFile.path);
    }
  }

  onClose(): void {
    this.clearPreviewRenderComponent();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-generate-modal");
    this.modalEl.addClass("ai-second-brain-generate-modal-shell");

    const scrollEl = contentEl.createDiv({ cls: "ai-second-brain-modal-scroll" });

    const header = scrollEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "wand-sparkles");
    const headerText = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    headerText.createEl("h2", { text: "生成笔记内容" });
    headerText.createEl("p", {
      cls: "ai-second-brain-muted",
      text: "输入写作目标，先生成预览，再决定插入当前笔记或创建新笔记。"
    });

    const form = scrollEl.createDiv({ cls: "ai-second-brain-generate-form" });

    new Setting(form)
      .setName("提示词")
      .setDesc("描述你想生成的内容，例如大纲、会议纪要、读书笔记或文章段落。")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.setPlaceholder("例如：根据当前项目笔记，生成一份下周计划大纲。");
        text.onChange((value) => {
          this.prompt = value.trim();
        });
      });

    new Setting(form)
      .setName("输出位置")
      .addDropdown((dropdown) => {
        if (this.editor) {
          dropdown.addOption("insert", "插入当前光标");
        }

        dropdown.addOption("new-note", "创建新笔记");
        dropdown.setValue(this.outputTarget);
        dropdown.onChange((value) => {
          this.outputTarget = value as OutputTarget;
          this.updateActionButtons();
        });
      });

    new Setting(form)
      .setName("新笔记标题")
      .setDesc("选择创建新笔记时使用。留空会自动生成标题。")
      .addText((text) =>
        text.setPlaceholder("例如：项目周报草稿").onChange((value) => {
          this.noteTitle = value.trim();
        })
      );

    new Setting(form)
      .setName("使用当前上下文")
      .setDesc("开启后会检索当前授权范围内的笔记作为参考。")
      .addToggle((toggle) =>
        toggle.setValue(this.useContext).onChange((value) => {
          this.useContext = value;
        })
      );

    const previewSection = scrollEl.createDiv({ cls: "ai-second-brain-generate-preview-section" });
    const previewHeader = previewSection.createDiv({ cls: "ai-second-brain-generate-preview-header" });
    previewHeader.createDiv({ cls: "ai-second-brain-generate-preview-title", text: "预览" });
    this.previewStatusEl = previewHeader.createDiv({ cls: "ai-second-brain-generate-preview-status", text: "等待生成" });
    this.previewEl = previewSection.createDiv({ cls: "ai-second-brain-generate-preview" });
    this.renderPreview("生成结果会显示在这里。", "empty");
    this.citationsEl = previewSection.createDiv({ cls: "ai-second-brain-generate-citations" });

    const actions = contentEl.createDiv({ cls: "ai-second-brain-modal-actions ai-second-brain-generate-actions" });
    this.generateButtonEl = createIconButton(actions, "sparkles", "生成预览", "mod-cta");
    this.generateButtonEl.addEventListener("click", () => {
      void this.generate();
    });

    this.insertButtonEl = createIconButton(actions, "corner-down-left", "插入当前笔记");
    this.insertButtonEl.disabled = true;
    this.insertButtonEl.addEventListener("click", () => {
      this.insertIntoEditor();
    });

    this.newNoteButtonEl = createIconButton(actions, "file-plus-2", "创建新笔记");
    this.newNoteButtonEl.disabled = true;
    this.newNoteButtonEl.addEventListener("click", () => {
      void this.createNewNote();
    });
    this.updateActionButtons();
  }

  private async generate(): Promise<void> {
    if (!this.prompt) {
      new Notice("请先输入提示词。");
      return;
    }

    this.setBusy(true);
    this.generatedContent = "";
    this.citations = [];
    this.renderPreview("正在生成...", "busy");
    this.renderCitations();
    this.setApplyEnabled(false);

    try {
      const response = await this.plugin.chatService.sendMessage(buildGenerationPrompt(this.prompt), {
        useContext: this.useContext,
        providerId: this.plugin.settings.defaultEditProviderId
      });

      this.generatedContent = response.content.trim();
      this.citations = response.citations;
      this.renderPreview(this.generatedContent || "没有收到 AI 响应。", this.generatedContent ? "ready" : "error");
      this.renderCitations();
      this.setApplyEnabled(Boolean(this.generatedContent));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
      this.renderPreview(`生成失败：${message}`, "error");
      this.setApplyEnabled(false);
    } finally {
      this.setBusy(false);
    }
  }

  private insertIntoEditor(): void {
    if (!this.editor || !this.insertionTarget) {
      new Notice("当前没有可插入的编辑器。");
      return;
    }

    if (!this.generatedContent) {
      return;
    }

    const currentFile = this.plugin.getMarkdownViewForEditor(this.editor)?.file;
    const result = this.insertionTarget.apply(this.generatedContent, currentFile?.path);

    if (!result.applied) {
      new Notice(result.reason);
      return;
    }

    this.close();
  }

  private async createNewNote(): Promise<void> {
    if (!this.generatedContent) {
      return;
    }

    try {
      const file = await this.plugin.createGeneratedNote(this.noteTitle, this.generatedContent);
      await this.app.workspace.getLeaf(false).openFile(file);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`创建笔记失败：${message}`);
    }
  }

  private renderPreview(content: string, state: "empty" | "busy" | "ready" | "error" = "ready"): void {
    if (!this.previewEl) {
      return;
    }

    this.clearPreviewRenderComponent();
    this.previewEl.empty();
    this.previewEl.removeClass("is-empty", "is-busy", "is-ready", "is-error");
    this.previewEl.addClass(`is-${state}`);

    if (this.previewStatusEl) {
      this.previewStatusEl.setText(state === "busy" ? "生成中" : state === "ready" ? "可应用" : state === "error" ? "需要处理" : "等待生成");
    }

    if (state === "empty") {
      const empty = this.previewEl.createDiv({ cls: "ai-second-brain-generate-empty" });
      const icon = empty.createDiv({ cls: "ai-second-brain-empty-icon" });
      setIcon(icon, "file-text");
      empty.createDiv({ cls: "ai-second-brain-empty-copy", text: content });
      return;
    }

    if (state === "busy") {
      const busy = this.previewEl.createDiv({ cls: "ai-second-brain-thinking" });
      busy.createSpan({ cls: "ai-second-brain-thinking-label", text: "正在生成预览" });
      const dots = busy.createSpan({ cls: "ai-second-brain-thinking-dots" });
      for (let index = 0; index < 3; index += 1) {
        dots.createSpan();
      }
      return;
    }

    const preEl = this.previewEl.createDiv();
    const renderComponent = new Component();
    renderComponent.load();
    this.previewRenderComponent = renderComponent;
    void MarkdownRenderer.render(this.app, content, preEl, "", renderComponent);
  }

  private renderCitations(): void {
    if (!this.citationsEl) {
      return;
    }

    this.citationsEl.empty();

    if (this.citations.length === 0) {
      return;
    }

    this.citationsEl.createDiv({ cls: "ai-second-brain-citations-title", text: "引用来源" });

    for (const citation of this.citations) {
      const item = this.citationsEl.createDiv({ cls: "ai-second-brain-generate-citation" });
      item.createDiv({
        cls: "ai-second-brain-citation-title",
        text: `${citation.title} · ${citation.startLine}-${citation.endLine}`
      });
      item.createDiv({ cls: "ai-second-brain-citation-path", text: citation.filePath });
      item.createDiv({ cls: "ai-second-brain-citation-excerpt", text: citation.excerpt });
    }
  }

  private setBusy(value: boolean): void {
    if (this.generateButtonEl) {
      this.generateButtonEl.disabled = value;
      this.generateButtonEl.toggleClass("is-loading", value);
      this.setButtonLabel(this.generateButtonEl, value ? "生成中..." : "生成预览");
    }
  }

  private setApplyEnabled(value: boolean): void {
    if (this.insertButtonEl) {
      this.insertButtonEl.disabled = !value;
    }

    if (this.newNoteButtonEl) {
      this.newNoteButtonEl.disabled = !value;
    }
  }

  private updateActionButtons(): void {
    if (this.insertButtonEl) {
      this.insertButtonEl.style.display = this.editor && this.outputTarget === "insert" ? "" : "none";
    }

    if (this.newNoteButtonEl) {
      this.newNoteButtonEl.style.display = this.outputTarget === "new-note" ? "" : "none";
    }
  }



  private setButtonLabel(button: HTMLButtonElement, text: string): void {
    const label = button.querySelector<HTMLElement>(".ai-second-brain-button-label");

    if (label) {
      label.setText(text);
    } else {
      button.setText(text);
    }
  }

  private clearPreviewRenderComponent(): void {
    if (!this.previewRenderComponent) {
      return;
    }

    this.previewRenderComponent.unload();
    this.previewRenderComponent = undefined;
  }
}

function buildGenerationPrompt(prompt: string): string {
  return [
    "请根据用户提示生成适合 Obsidian 笔记的 Markdown 内容。",
    "要求：",
    "- 只输出正文，不要包裹代码块。",
    "- 使用清晰标题、列表或段落结构。",
    "- 如果上下文不足，请给出合理草稿，不要编造具体事实。",
    "",
    `用户提示：${prompt}`
  ].join("\n");
}
