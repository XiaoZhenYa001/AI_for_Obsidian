import { Modal, Notice, Setting, TFile } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { DrawingEditPlan, parseDrawingEditPlan } from "./drawing-edit-plan";
import { DrawingSnapshot, isExcalidrawFile } from "./excalidraw-edit-service";
import { ChatMessage } from "../providers/types";

export type DrawingEditResult = { path: string; count: number; instruction: string };

export function editDrawing(
  plugin: ObsidianAIPlugin, instruction = "", file?: TFile,
  options: { history?: ChatMessage[]; directText?: boolean } = {}
): Promise<DrawingEditResult | undefined> {
  return new Promise((resolve) => new EditDrawingModal(plugin, instruction, file, resolve, options).open());
}

class EditDrawingModal extends Modal {
  private file?: TFile;
  private instruction: string;
  private mode: "ai" | "text" = "ai";
  private x = 0;
  private y = 0;
  private snapshot?: DrawingSnapshot;
  private plan?: DrawingEditPlan;
  private previewEl?: HTMLElement;
  private generateButton?: HTMLButtonElement;
  private applyButton?: HTMLButtonElement;
  private controller?: AbortController;
  private controls: Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = [];
  private closed = false;
  private applying = false;
  private result?: DrawingEditResult;

  constructor(
    private readonly plugin: ObsidianAIPlugin,
    instruction: string,
    file: TFile | undefined,
    private readonly done: (result: DrawingEditResult | undefined) => void,
    private readonly options: { history?: ChatMessage[]; directText?: boolean }
  ) {
    super(plugin.app);
    this.file = file;
    this.instruction = instruction.replace(/^\/draw\s*/i, "");
    this.mode = options.directText ? "text" : "ai";
  }

  onOpen(): void {
    this.contentEl.addClass("ai-second-brain-drawing-edit");
    this.contentEl.createEl("h2", { text: "编辑 Excalidraw 画布" });
    this.contentEl.createEl("p", { text: "选择目标画布，预览文字和坐标后应用。可在 Excalidraw 中撤销。" });
    const files = this.app.vault.getFiles().filter((file) => isExcalidrawFile(file, this.app));
    if (!this.file) this.file = files[0];
    new Setting(this.contentEl).setName("目标画布").addDropdown((dropdown) => {
      files.forEach((file) => dropdown.addOption(file.path, file.path));
      dropdown.setValue(this.file?.path || "").onChange((path) => {
        this.file = files.find((file) => file.path === path);
        this.invalidate();
      });
      this.controls.push(dropdown.selectEl);
    });
    new Setting(this.contentEl).setName("输入方式").addDropdown((dropdown) => {
      dropdown.addOption("ai", "用对话指令定位和修改").addOption("text", "直接在坐标处插入文本")
        .setValue(this.mode).onChange((value) => { this.mode = value as "ai" | "text"; this.invalidate(); });
      this.controls.push(dropdown.selectEl);
    });
    new Setting(this.contentEl).setName("指令 / 文本").setDesc("例如：在“项目计划”标题下方添加三条待办；或将选中的文字改为“已完成”。")
      .addTextArea((input) => {
        input.setValue(this.instruction).onChange((value) => { this.instruction = value; this.invalidate(); });
        input.inputEl.rows = 5;
        this.controls.push(input.inputEl);
      });
    const position = new Setting(this.contentEl).setName("插入坐标").setDesc("直接插入模式使用此坐标；AI 模式可在指令中指定位置。");
    for (const axis of ["x", "y"] as const) {
      position.addText((input) => {
        input.inputEl.type = "number";
        input.inputEl.setAttribute("aria-label", axis);
        input.setValue("0").setPlaceholder(axis).onChange((value) => { this[axis] = Number(value); this.invalidate(); });
        this.controls.push(input.inputEl);
      });
    }
    this.previewEl = this.contentEl.createDiv({ cls: "ai-second-brain-drawing-edit-preview" });
    const actions = this.contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    this.generateButton = actions.createEl("button", { text: "预览修改" });
    this.generateButton.addEventListener("click", () => {
      if (this.controller) this.controller.abort();
      else void this.generate();
    });
    this.applyButton = actions.createEl("button", { text: "应用修改", cls: "mod-cta" });
    this.applyButton.disabled = true;
    this.applyButton.addEventListener("click", () => void this.apply());
    const cancel = actions.createEl("button", { text: "关闭" });
    cancel.addEventListener("click", () => { if (!this.applying) this.close(); });
    if (!this.file) this.previewEl.setText("没有找到 Excalidraw 文件，请先创建或导入画布。");
  }

  onClose(): void {
    this.closed = true;
    this.controller?.abort();
    // An in-flight commit completes before reporting its result to the chat.
    if (!this.applying) this.done(this.result);
  }

  private invalidate(): void {
    this.controller?.abort();
    this.plan = undefined;
    this.snapshot = undefined;
    this.previewEl?.empty();
    if (this.applyButton) this.applyButton.disabled = true;
  }

  private async generate(): Promise<void> {
    if (!this.file || !this.instruction.trim() || this.controller || this.applying) return;
    const controller = new AbortController();
    this.controller = controller;
    this.plan = undefined;
    if (this.applyButton) this.applyButton.disabled = true;
    this.setBusy(true);
    this.previewEl?.setText("正在读取画布并生成预览…");
    try {
      const snapshot = await this.plugin.excalidrawEditService.capture(this.file);
      if (controller.signal.aborted || this.closed) return;
      const plan = this.mode === "text"
        ? parseDrawingEditPlan(JSON.stringify({ summary: "插入文本", edits: [{ type: "add-text", text: this.instruction, x: this.x, y: this.y }] }), snapshot.elements)
        : await this.plugin.excalidrawEditService.propose(snapshot, this.instruction, controller.signal, this.options.history);
      if (controller.signal.aborted || this.closed) return;
      this.snapshot = snapshot;
      this.plan = plan;
      this.renderPreview();
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) this.previewEl?.setText(error instanceof Error ? error.message : String(error));
    } finally {
      this.controller = undefined;
      if (!this.closed) {
        this.setBusy(false);
        if (controller.signal.aborted) this.previewEl?.setText("已停止，可重新生成预览。");
      }
    }
  }

  private renderPreview(): void {
    if (!this.plan || !this.previewEl) return;
    this.previewEl.empty();
    this.previewEl.createEl("h3", { text: this.plan.summary });
    for (const edit of this.plan.edits) {
      const row = this.previewEl.createDiv({ cls: "ai-second-brain-drawing-edit-item" });
      row.createEl("strong", { text: `${edit.type === "add-text" ? "新增" : "修改"} · (${edit.x}, ${edit.y}) · ${edit.fontSize}px` });
      if (edit.elementId) row.createEl("small", { text: `元素 ${edit.elementId}` });
      const text = row.createEl("textarea", { attr: { "aria-label": "预览文本" } });
      text.value = edit.text;
      text.rows = Math.min(8, Math.max(2, edit.text.split("\n").length));
      text.addEventListener("input", () => { edit.text = text.value; });
      this.controls.push(text);
    }
    if (this.applyButton) this.applyButton.disabled = false;
  }

  private async apply(): Promise<void> {
    if (!this.plan || !this.snapshot || this.applying) return;
    this.applying = true;
    this.setBusy(true);
    try {
      const count = await this.plugin.excalidrawEditService.apply(this.snapshot, this.plan);
      this.result = { path: this.snapshot.path, count, instruction: this.instruction };
      new Notice(`已更新 ${count} 项画布文本，可在 Excalidraw 中撤销。`);
      this.applying = false;
      if (this.closed) this.done(this.result); else this.close();
    } catch (error) {
      this.applying = false;
      if (this.closed) { this.done(undefined); return; }
      new Notice(error instanceof Error ? error.message : String(error));
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    for (const input of this.controls) input.disabled = busy;
    if (this.generateButton) {
      this.generateButton.textContent = this.controller ? "停止生成" : "预览修改";
      this.generateButton.disabled = this.applying;
    }
    if (this.applyButton) this.applyButton.disabled = busy || !this.plan;
  }
}
