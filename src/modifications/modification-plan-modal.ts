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

  constructor(
    app: App,
    private readonly plugin: ObsidianAIPlugin,
    private readonly objective: string,
    private readonly filePaths: string[]
  ) {
    super(app);
  }

  onOpen(): void {
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

  private async generate(): Promise<void> {
    try {
      this.plan = await this.plugin.modificationService.createPlan(this.objective, this.filePaths);
      this.selected = new Set(this.plan.items.filter((item) => item.operation !== "delete").map((item) => item.id));
      this.renderPlan();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bodyEl?.empty();
      this.bodyEl?.createDiv({ cls: "ai-second-brain-modification-plan-error", text: message });
      new Notice(message);
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
    const list = this.bodyEl.createDiv({ cls: "ai-second-brain-modification-list" });
    for (const item of this.plan.items) this.renderItem(list, item);
    this.updateApplyButton();
  }

  private renderItem(container: HTMLElement, item: ModificationPlanItem): void {
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
      renderCompactDiff(detail, item.originalContent || "", item.proposedContent || "");
    } else if (item.operation === "create") {
      detail.createEl("pre", { text: item.proposedContent || "" });
    } else {
      detail.createDiv({ cls: "ai-second-brain-muted", text: item.operation === "delete" ? "应用后文件会移入系统回收站。" : `文件将移动到 ${item.targetPath}` });
    }
  }

  private updateApplyButton(): void {
    if (this.applyButton) this.applyButton.disabled = this.selected.size === 0 || !this.plan;
  }

  private async apply(): Promise<void> {
    if (!this.plan || !this.applyButton) return;
    this.applyButton.disabled = true;
    try {
      const count = await this.plugin.modificationService.applyPlan(this.plan, this.selected);
      new Notice(`已应用 ${count} 项修改，可通过命令面板撤销本批次。`);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
      this.applyButton.disabled = false;
    }
  }
}

function operationLabel(operation: ModificationPlanItem["operation"]): string {
  return operation === "update" ? "更新" : operation === "create" ? "新建" : operation === "rename" ? "移动" : "删除";
}

function renderCompactDiff(container: HTMLElement, original: string, proposed: string): void {
  const diff = container.createDiv({ cls: "ai-second-brain-modification-diff" });
  const changes = buildLineDiff(original, proposed).filter((operation) => operation.type !== "equal");
  for (const operation of changes.slice(0, 80)) {
    const added = operation.type === "added";
    diff.createDiv({
      cls: added ? "is-added" : "is-removed",
      text: `${added ? "+" : "−"} ${operation.text}`
    });
  }
  if (changes.length === 0) diff.createDiv({ cls: "ai-second-brain-muted", text: "内容没有变化。" });
  if (changes.length > 80) diff.createDiv({ cls: "ai-second-brain-muted", text: `还有 ${changes.length - 80} 行变化未展示。` });
}
