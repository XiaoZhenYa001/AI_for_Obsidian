import { App, Modal, setIcon } from "obsidian";
import { createIconButton } from "./icon-button";

type DiffOp = {
  type: "equal" | "added" | "removed";
  text: string;
};

export class DiffPreviewModal extends Modal {
  constructor(
    app: App,
    private readonly original: string,
    private readonly proposed: string,
    private readonly onApply: (value: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-diff-modal");

    this.scope.register([], "Enter", () => {
      this.onApply(this.proposed);
      this.close();
    });

    const operations = buildLineDiff(this.original, this.proposed);
    const addedCount = operations.filter((op) => op.type === "added").length;
    const removedCount = operations.filter((op) => op.type === "removed").length;

    const header = contentEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "file-check-2");
    const headerText = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    headerText.createEl("h2", { text: "预览 AI 修改" });
    headerText.createEl("p", {
      cls: "ai-second-brain-muted",
      text: "确认后才会写入笔记。取消会保留原文。"
    });

    const summary = contentEl.createDiv({ cls: "ai-second-brain-diff-summary" });
    summary.createSpan({ cls: "ai-second-brain-diff-stat ai-second-brain-diff-stat-added", text: `+${addedCount}` });
    summary.createSpan({ cls: "ai-second-brain-diff-stat ai-second-brain-diff-stat-removed", text: `-${removedCount}` });

    const diffEl = contentEl.createDiv({ cls: "ai-second-brain-diff" });

    for (const op of operations) {
      const row = diffEl.createDiv({
        cls: `ai-second-brain-diff-row ai-second-brain-diff-${op.type}`
      });
      row.createSpan({
        cls: "ai-second-brain-diff-marker",
        text: markerFor(op.type)
      });
      row.createSpan({
        cls: "ai-second-brain-diff-text",
        text: op.text || " "
      });
    }

    const actions = contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancelButton = createIconButton(actions, "x", "取消");
    cancelButton.addEventListener("click", () => {
      this.close();
    });

    const applyButton = createIconButton(actions, "check", "应用修改", "mod-cta");
    applyButton.addEventListener("click", () => {
      this.onApply(this.proposed);
      this.close();
    });
  }

}

function buildLineDiff(original: string, proposed: string): DiffOp[] {
  const oldLines = original.split(/\r?\n/);
  const newLines = proposed.split(/\r?\n/);

  if (oldLines.length * newLines.length > 40000) {
    return [
      ...oldLines.map((text) => ({ type: "removed" as const, text })),
      ...newLines.map((text) => ({ type: "added" as const, text }))
    ];
  }

  const table = Array.from({ length: oldLines.length + 1 }, () =>
    Array.from({ length: newLines.length + 1 }, () => 0)
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        table[oldIndex][newIndex] = table[oldIndex + 1][newIndex + 1] + 1;
      } else {
        table[oldIndex][newIndex] = Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: "equal", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      ops.push({ type: "removed", text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      ops.push({ type: "added", text: newLines[newIndex] });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    ops.push({ type: "removed", text: oldLines[oldIndex] });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    ops.push({ type: "added", text: newLines[newIndex] });
    newIndex += 1;
  }

  return ops;
}

function markerFor(type: DiffOp["type"]): string {
  if (type === "added") {
    return "+";
  }

  if (type === "removed") {
    return "-";
  }

  return " ";
}
