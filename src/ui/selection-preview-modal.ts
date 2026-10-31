import { App, Modal, setIcon } from "obsidian";
import { createIconButton } from "./icon-button";

export type SelectionPreviewContext = {
  actionLabel: string;
  fileName: string;
  startLine: number;
  before: string;
  original: string;
  after: string;
};

export class SelectionPreviewModal extends Modal {
  private proposedEl?: HTMLTextAreaElement;
  private statusEl?: HTMLElement;
  private insertButton?: HTMLButtonElement;
  private replaceButton?: HTMLButtonElement;
  private proposed = "";
  private generating = true;
  private closed = false;
  private removeDragListeners?: () => void;
  private removeResizeListener?: () => void;
  private pendingRender?: number;
  private pendingRenderWindow?: Window;
  private editorHeightCapped = false;

  constructor(
    app: App,
    private readonly context: SelectionPreviewContext,
    private readonly onInsert: (value: string) => boolean | void,
    private readonly onReplace: (value: string) => boolean | void,
    private readonly onCancelGeneration: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ai-second-brain-selection-preview-shell");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-selection-preview");

    const header = contentEl.createDiv({ cls: "ai-second-brain-modal-header ai-second-brain-selection-preview-drag-handle" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "scan-text");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: `${this.context.actionLabel}预览` });
    heading.createEl("p", {
      cls: "ai-second-brain-muted",
      text: `${this.context.fileName} · 第 ${this.context.startLine} 行附近`
    });
    const dragIcon = header.createDiv({
      cls: "ai-second-brain-selection-preview-drag-icon",
      attr: { "aria-hidden": "true" }
    });
    setIcon(dragIcon, "grip-horizontal");
    this.enableDragging(header);

    const document = contentEl.createDiv({
      cls: "ai-second-brain-selection-preview-document",
      attr: { "aria-label": "原文上下文与 AI 建议" }
    });

    this.renderContextBlock(document, this.context.before, "ai-second-brain-selection-preview-context");

    const original = document.createDiv({ cls: "ai-second-brain-selection-preview-original" });
    original.createDiv({ cls: "ai-second-brain-selection-preview-label", text: "原选区" });
    original.createEl("div", {
      cls: "ai-second-brain-selection-preview-text",
      text: this.context.original
    });

    const proposed = document.createDiv({ cls: "ai-second-brain-selection-preview-proposed" });
    const proposedHeader = proposed.createDiv({ cls: "ai-second-brain-selection-preview-proposed-header" });
    proposedHeader.createDiv({ cls: "ai-second-brain-selection-preview-label", text: "AI 建议" });
    this.statusEl = proposedHeader.createDiv({ cls: "ai-second-brain-selection-preview-status is-generating" });
    this.statusEl.createSpan({ cls: "ai-second-brain-selection-preview-spinner" });
    this.statusEl.createSpan({ cls: "ai-second-brain-selection-preview-status-text", text: "正在生成" });
    this.proposedEl = proposed.createEl("textarea", {
      cls: "ai-second-brain-selection-preview-editor",
      attr: {
        "aria-label": "可编辑的 AI 建议内容",
        spellcheck: "true"
      }
    });
    this.proposedEl.readOnly = true;
    this.proposedEl.placeholder = "AI 正在读取选区与上下文…";
    this.resizeEditor();
    this.proposedEl.addEventListener("input", () => this.resizeEditor());
    const ownerWindow = this.modalEl.ownerDocument.defaultView;
    if (ownerWindow) {
      const onResize = (): void => this.resizeEditor();
      ownerWindow.addEventListener("resize", onResize);
      this.removeResizeListener = () => ownerWindow.removeEventListener("resize", onResize);
    }

    this.renderContextBlock(document, this.context.after, "ai-second-brain-selection-preview-context");

    const footer = contentEl.createDiv({ cls: "ai-second-brain-selection-preview-footer" });
    footer.createDiv({
      cls: "ai-second-brain-selection-preview-hint",
      text: "只有确认后才会写入原笔记"
    });
    const actions = footer.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancelButton = createIconButton(actions, "x", "取消", "ai-second-brain-selection-preview-action is-cancel");
    cancelButton.addEventListener("click", () => this.close());
    this.insertButton = createIconButton(
      actions,
      "corner-down-left",
      "插入",
      "ai-second-brain-selection-preview-action is-insert"
    );
    this.insertButton.disabled = true;
    this.insertButton.addEventListener("click", () => this.apply(this.onInsert));
    this.replaceButton = createIconButton(
      actions,
      "replace",
      "替换",
      "ai-second-brain-selection-preview-action is-replace"
    );
    this.replaceButton.disabled = true;
    this.replaceButton.addEventListener("click", () => this.apply(this.onReplace));
  }

  onClose(): void {
    this.closed = true;
    this.cancelPendingRender();
    this.removeDragListeners?.();
    this.removeResizeListener?.();
    if (this.generating) {
      this.onCancelGeneration();
    }
    this.contentEl.empty();
    this.proposedEl = undefined;
  }

  appendDelta(delta: string): void {
    if (this.closed || !this.generating || !delta) {
      return;
    }

    this.proposed += delta;
    if (this.pendingRender !== undefined) {
      return;
    }
    const ownerWindow = this.modalEl.ownerDocument.defaultView;
    if (!ownerWindow) {
      this.renderProposed();
      return;
    }
    this.pendingRenderWindow = ownerWindow;
    this.pendingRender = ownerWindow.setTimeout(() => {
      this.pendingRender = undefined;
      this.pendingRenderWindow = undefined;
      this.renderProposed();
    }, 60);
  }

  complete(): void {
    if (this.closed) {
      return;
    }

    if (!this.proposed.trim()) {
      this.fail("未返回内容");
      return;
    }

    this.renderProposed();
    this.generating = false;
    if (this.proposedEl) {
      this.proposedEl.readOnly = false;
    }
    this.insertButton?.removeAttribute("disabled");
    this.replaceButton?.removeAttribute("disabled");
    this.setStatus("生成完成", "complete");
  }

  fail(message: string): void {
    if (this.closed) {
      return;
    }

    this.renderProposed();
    this.generating = false;
    this.setStatus(message, "error");
    if (this.proposedEl) {
      this.proposedEl.placeholder = "未能生成建议内容";
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  private cancelPendingRender(): void {
    if (this.pendingRender !== undefined) {
      this.pendingRenderWindow?.clearTimeout(this.pendingRender);
      this.pendingRender = undefined;
      this.pendingRenderWindow = undefined;
    }
  }

  private renderProposed(): void {
    this.cancelPendingRender();
    const editor = this.proposedEl;
    if (this.closed || !editor || editor.value === this.proposed) {
      return;
    }
    const previousTop = editor.scrollTop;
    const followOutput = editor.scrollHeight - editor.clientHeight - previousTop <= 24;
    editor.value = this.proposed;
    if (!this.editorHeightCapped) {
      this.resizeEditor();
    }
    editor.scrollTop = followOutput ? editor.scrollHeight : previousTop;
  }

  private renderContextBlock(container: HTMLElement, text: string, className: string): void {
    if (!text.trim()) {
      return;
    }

    container.createEl("div", {
      cls: className,
      text
    });
  }

  private apply(handler: (value: string) => boolean | void): void {
    const value = this.proposedEl?.value.trim();

    if (!value) {
      this.proposedEl?.focus();
      return;
    }

    if (handler(value) !== false) {
      this.close();
    }
  }

  private setStatus(text: string, state: "complete" | "error"): void {
    if (!this.statusEl) {
      return;
    }

    this.statusEl.empty();
    this.statusEl.removeClass("is-generating");
    this.statusEl.addClass(`is-${state}`);
    const icon = this.statusEl.createSpan({ cls: "ai-second-brain-selection-preview-status-icon" });
    setIcon(icon, state === "complete" ? "check" : "circle-alert");
    this.statusEl.createSpan({ cls: "ai-second-brain-selection-preview-status-text", text });
  }

  private enableDragging(handle: HTMLElement): void {
    const ownerWindow = this.modalEl.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }

    let pointerId: number | undefined;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let minOffsetX = 0;
    let maxOffsetX = 0;
    let minOffsetY = 0;
    let maxOffsetY = 0;

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) {
        return;
      }

      const nextX = clamp(offsetX + event.clientX - startX, minOffsetX, maxOffsetX);
      const nextY = clamp(offsetY + event.clientY - startY, minOffsetY, maxOffsetY);
      this.modalEl.style.transform = `translate3d(${Math.round(nextX)}px, ${Math.round(nextY)}px, 0)`;
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) {
        return;
      }
      pointerId = undefined;
      handle.removeClass("is-dragging");
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, textarea")) {
        return;
      }
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      const transform = this.modalEl.style.transform.match(/translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/);
      offsetX = transform ? Number(transform[1]) : 0;
      offsetY = transform ? Number(transform[2]) : 0;
      const rect = this.modalEl.getBoundingClientRect();
      const baseLeft = rect.left - offsetX;
      const baseTop = rect.top - offsetY;
      minOffsetX = 8 - baseLeft;
      maxOffsetX = ownerWindow.innerWidth - 8 - baseLeft - rect.width;
      minOffsetY = 8 - baseTop;
      maxOffsetY = ownerWindow.innerHeight - 8 - baseTop - rect.height;
      handle.addClass("is-dragging");
      event.preventDefault();
    };

    handle.addEventListener("pointerdown", onPointerDown);
    ownerWindow.addEventListener("pointermove", onPointerMove);
    ownerWindow.addEventListener("pointerup", onPointerUp);
    ownerWindow.addEventListener("pointercancel", onPointerUp);
    this.removeDragListeners = () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      ownerWindow.removeEventListener("pointermove", onPointerMove);
      ownerWindow.removeEventListener("pointerup", onPointerUp);
      ownerWindow.removeEventListener("pointercancel", onPointerUp);
    };
  }

  private resizeEditor(): void {
    if (!this.proposedEl) {
      return;
    }

    const previousTop = this.proposedEl.scrollTop;
    this.proposedEl.style.height = "auto";
    const height = Math.min(Math.max(this.proposedEl.scrollHeight, 96), 320);
    this.editorHeightCapped = height === 320;
    this.proposedEl.style.height = `${height}px`;
    this.proposedEl.scrollTop = previousTop;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
