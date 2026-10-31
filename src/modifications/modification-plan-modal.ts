import { App, Modal, Notice, setIcon } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { createIconButton } from "../ui/icon-button";
import { buildLineDiff } from "../ui/diff-preview-modal";
import type { ModificationPlan, ModificationPlanItem } from "./types";

export class ModificationPlanModal extends Modal {
  private plan?: ModificationPlan;
  private selected = new Set<string>();
  private bodyEl?: HTMLElement;
  private applyButton?: HTMLButtonElement;
  private generationController?: AbortController;
  private closed = false;
  private isApplying = false;

  constructor(
    app: App,
    private readonly plugin: ObsidianAIPlugin,
    private readonly objective: string,
    private readonly filePaths: string[],
    private readonly generatePlan?: (signal: AbortSignal) => Promise<ModificationPlan>
  ) {
    super(app);
  }

  onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("ai-second-brain-modification-plan-shell");
    this.contentEl.addClass("ai-second-brain-modification-plan-modal");
    const header = this.contentEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "files");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: "AI 修改计划" });
    heading.createEl("p", { cls: "ai-second-brain-muted", text: "逐项审查后再写入；应用前会再次校验文件内容。" });
    this.bodyEl = this.contentEl.createDiv({ cls: "ai-second-brain-modification-plan-body" });
    this.renderLoading();
    const actions = this.contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancel = createIconButton(actions, "x", "取消");
    cancel.addEventListener("click", () => this.close());
    this.applyButton = createIconButton(actions, "check", "应用所选修改", "mod-cta");
    this.applyButton.disabled = true;
    this.applyButton.addEventListener("click", () => void this.apply());
    void this.generate();
  }

  onClose(): void {
    this.closed = true;
    this.generationController?.abort();
  }

  private async generate(): Promise<void> {
    if (this.closed || this.generationController) return;
    const controller = new AbortController();
    this.generationController = controller;
    try {
      const plan = this.generatePlan
        ? await this.generatePlan(controller.signal)
        : await this.plugin.modificationService.createPlan(this.objective, this.filePaths, controller.signal);
      if (this.closed || controller.signal.aborted) return;
      this.plan = plan;
      this.selected = new Set(this.plan.items.filter((item) => item.operation !== "delete").map((item) => item.id));
      this.renderPlan();
    } catch (error) {
      if (this.closed || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.bodyEl?.empty();
      this.bodyEl?.createDiv({ cls: "ai-second-brain-modification-plan-error", text: message });
      new Notice(message);
    } finally {
      this.generationController = undefined;
    }
  }

  private renderLoading(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const state = this.bodyEl.createDiv({ cls: "ai-second-brain-modification-plan-loading" });
    state.createDiv({ cls: "ai-second-brain-thinking-label", text: "正在读取笔记并生成修改计划" });
    const dots = state.createDiv({ cls: "ai-second-brain-thinking-dots" });
    for (let index = 0; index < 3; index += 1) dots.createSpan();
  }

  private renderPlan(): void {
    if (!this.bodyEl || !this.plan) return;
    this.bodyEl.empty();
    const summary = this.bodyEl.createDiv({ cls: "ai-second-brain-modification-plan-summary" });
    summary.createDiv({ cls: "ai-second-brain-modification-plan-title", text: this.plan.title });
    summary.createDiv({ cls: "ai-second-brain-modification-plan-rationale", text: this.plan.rationale });
    if (this.plan.coverage) {
      const { included, skipped } = this.plan.coverage;
      const coverage = summary.createEl("details");
      coverage.createEl("summary", { text: `已提供 ${included.length} 个文件供 AI 分析，跳过 ${skipped.length} 个文件` });
      coverage.createDiv({ cls: "ai-second-brain-muted", text: "提供给 AI 不代表每个文件都有修改项。" });
      for (const path of included) coverage.createDiv({ text: `已提供：${path}` });
      for (const item of skipped) coverage.createDiv({ text: `已跳过：${item.path}（${item.reason}）` });
    }
    const list = this.bodyEl.createDiv({ cls: "ai-second-brain-modification-list" });
    for (const item of this.plan.items) this.renderItem(list, item);
    this.updateApplyButton();
  }

  private renderItem(container: HTMLElement, item: ModificationPlanItem): void {
    const changes = item.operation === "update"
      ? buildLineDiff(item.originalContent || "", item.proposedContent || "").filter((operation) => operation.type !== "equal")
      : undefined;
    // Large updates require an explicit choice after opening the preview.
    if (changes && changes.length > 80) this.selected.delete(item.id);
    const row = container.createEl("details", { cls: "ai-second-brain-modification-item" });
    const summary = row.createEl("summary", { cls: "ai-second-brain-modification-item-summary" });
    const checkbox = summary.createEl("input", { type: "checkbox" });
    checkbox.checked = this.selected.has(item.id);
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selected.add(item.id); else this.selected.delete(item.id);
      this.updateApplyButton();
    });
    summary.createSpan({ cls: `ai-second-brain-modification-kind is-${item.operation}`, text: operationLabel(item.operation) });
    const copy = summary.createSpan({ cls: "ai-second-brain-modification-copy" });
    copy.createSpan({ cls: "ai-second-brain-modification-path", text: item.targetPath ? `${item.path} → ${item.targetPath}` : item.path });
    copy.createSpan({ cls: "ai-second-brain-modification-description", text: item.summary });
    const chevron = summary.createSpan({ cls: "ai-second-brain-modification-chevron" });
    setIcon(chevron, "chevron-down");
    const detail = row.createDiv({ cls: "ai-second-brain-modification-detail" });
    if (item.operation === "update") {
      if (changes && changes.length > 80) detail.createDiv({ cls: "ai-second-brain-muted", text: "此修改超过 80 行，默认未选中；请检查后手动选择。" });
      renderDiff(detail, changes || []);
    } else if (item.operation === "create") {
      detail.createEl("pre", { text: item.proposedContent || "" });
    } else {
      detail.createDiv({ cls: "ai-second-brain-muted", text: item.operation === "delete" ? "应用后文件会移入系统回收站。" : `文件将移动到 ${item.targetPath}` });
    }
  }

  private updateApplyButton(): void {
    if (this.applyButton) this.applyButton.disabled = this.isApplying || this.selected.size === 0 || !this.plan;
  }

  private async apply(): Promise<void> {
    if (!this.plan || !this.applyButton || this.isApplying || this.closed) return;
    this.isApplying = true;
    this.applyButton.disabled = true;
    try {
      const count = await this.plugin.modificationService.applyPlan(this.plan, this.selected);
      new Notice(`已应用 ${count} 项修改，可通过命令面板撤销本批次。`);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
    } finally {
      this.isApplying = false;
      if (!this.closed) this.updateApplyButton();
    }
  }
}

function operationLabel(operation: ModificationPlanItem["operation"]): string {
  return operation === "update" ? "更新" : operation === "create" ? "新建" : operation === "rename" ? "移动" : "删除";
}

function renderDiff(container: HTMLElement, changes: ReturnType<typeof buildLineDiff>): void {
  const diff = container.createDiv({ cls: "ai-second-brain-modification-diff" });
  if (changes.length === 0) diff.createDiv({ cls: "ai-second-brain-muted", text: "内容没有变化。" });
  let offset = 0;
  let more: HTMLButtonElement | undefined;
  const append = () => {
    more?.remove();
    for (const operation of changes.slice(offset, offset + 80)) {
      const added = operation.type === "added";
      diff.createDiv({ cls: added ? "is-added" : "is-removed", text: `${added ? "+" : "−"} ${operation.text}` });
    }
    offset = Math.min(offset + 80, changes.length);
    if (offset < changes.length) {
      more = diff.createEl("button", { text: `显示更多变化（剩余 ${changes.length - offset} 行）` });
      more.type = "button";
      more.addEventListener("click", append);
    }
  };
  append();
}
