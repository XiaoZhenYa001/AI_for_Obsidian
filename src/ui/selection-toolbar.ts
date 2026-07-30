import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { IconName, setIcon } from "obsidian";
import { runSelectionAction, SelectionActionType } from "../actions/selection-actions";
import { SelectionReference } from "../chat/types";
import { GenerateDiagramModal } from "../diagrams/generate-diagram-modal";
import type ObsidianAIPlugin from "../main";

type ToolbarAction =
  | { label: string; icon: IconName; addToChat: true }
  | { label: string; icon: IconName; selectionAction: SelectionActionType }
  | { label: string; icon: IconName; diagram: true };

const ACTIONS: ToolbarAction[] = [
  { label: "添加到对话", icon: "message-square-plus", addToChat: true },
  { label: "解释", icon: "circle-help", selectionAction: "explain" },
  { label: "总结", icon: "list-checks", selectionAction: "summarize" },
  { label: "改写", icon: "wand-sparkles", selectionAction: "rewrite" },
  { label: "翻译", icon: "languages", selectionAction: "translate" },
  { label: "扩写", icon: "text-cursor-input", selectionAction: "expand" },
  { label: "缩写", icon: "minimize-2", selectionAction: "condense" },
  { label: "生成图谱", icon: "workflow", diagram: true }
];

export function createSelectionToolbarExtension(plugin: ObsidianAIPlugin): Extension {
  return ViewPlugin.define((view) => new SelectionToolbarView(view, plugin));
}

class SelectionToolbarView {
  private readonly toolbarEl: HTMLElement;
  private animationFrame?: number;

  constructor(
    private readonly editorView: EditorView,
    private readonly plugin: ObsidianAIPlugin
  ) {
    const ownerDocument = editorView.dom.ownerDocument;
    this.toolbarEl = ownerDocument.createElement("div");
    this.toolbarEl.className = "ai-second-brain-selection-toolbar";
    this.toolbarEl.setAttribute("role", "toolbar");
    this.toolbarEl.setAttribute("aria-label", "AI 选区工具");
    this.toolbarEl.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });

    for (const [index, action] of ACTIONS.entries()) {
      if (index === 1 || "diagram" in action) {
        this.toolbarEl.appendChild(this.createDivider(ownerDocument));
      }
      this.toolbarEl.appendChild(this.createActionButton(ownerDocument, action));
    }

    ownerDocument.body.appendChild(this.toolbarEl);
    this.scheduleUpdate();
  }

  update(update: ViewUpdate): void {
    if (
      update.selectionSet ||
      update.docChanged ||
      update.focusChanged ||
      update.geometryChanged ||
      update.viewportChanged
    ) {
      this.scheduleUpdate();
    }
  }

  destroy(): void {
    if (this.animationFrame !== undefined) {
      this.editorView.dom.ownerDocument.defaultView?.cancelAnimationFrame(this.animationFrame);
    }
    this.toolbarEl.remove();
  }

  private createDivider(ownerDocument: Document): HTMLElement {
    const divider = ownerDocument.createElement("span");
    divider.className = "ai-second-brain-selection-toolbar-divider";
    divider.setAttribute("aria-hidden", "true");
    return divider;
  }

  private createActionButton(ownerDocument: Document, action: ToolbarAction): HTMLButtonElement {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.className = "ai-second-brain-selection-toolbar-button";
    button.title = action.label;
    button.setAttribute("aria-label", action.label);
    const icon = ownerDocument.createElement("span");
    icon.className = "ai-second-brain-selection-toolbar-icon";
    setIcon(icon, action.icon);
    button.appendChild(icon);
    button.addEventListener("click", () => {
      this.runAction(action);
    });
    return button;
  }

  private runAction(action: ToolbarAction): void {
    const markdownView = this.plugin.getMarkdownViewForElement(this.editorView.dom);
    const editor = markdownView?.editor;

    if (!markdownView || !editor || !markdownView.file) {
      this.hide();
      return;
    }

    if ("addToChat" in action) {
      const references = this.createSelectionReferences(markdownView.file.path, markdownView.file.name);
      if (references.length === 0) {
        this.hide();
        return;
      }
      this.plugin.addSelectionReferences(references);
      this.editorView.focus();
      return;
    }

    if (!editor.somethingSelected()) {
      this.hide();
      return;
    }

    this.hide();
    if ("selectionAction" in action) {
      void runSelectionAction(this.plugin, editor, action.selectionAction);
      return;
    }

    new GenerateDiagramModal(
      this.plugin.app,
      this.plugin,
      editor,
      markdownView.file || undefined
    ).open();
  }

  private createSelectionReferences(filePath: string, fileName: string): SelectionReference[] {
    return this.editorView.state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => {
        const from = Math.min(range.from, range.to);
        const to = Math.max(range.from, range.to);
        const fromLine = this.editorView.state.doc.lineAt(from);
        const toLine = this.editorView.state.doc.lineAt(to);
        return {
          id: `selection-${crypto.randomUUID()}`,
          filePath,
          fileName,
          fromLine: fromLine.number - 1,
          fromCh: from - fromLine.from,
          toLine: toLine.number - 1,
          toCh: to - toLine.from,
          text: this.editorView.state.doc.sliceString(from, to)
        };
      });
  }

  private scheduleUpdate(): void {
    const ownerWindow = this.editorView.dom.ownerDocument.defaultView;
    if (!ownerWindow) {
      return;
    }

    if (this.animationFrame !== undefined) {
      ownerWindow.cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = ownerWindow.requestAnimationFrame(() => {
      this.animationFrame = undefined;
      this.updatePosition();
    });
  }

  private updatePosition(): void {
    const selection = this.editorView.state.selection;
    const ranges = selection.ranges.filter((range) => !range.empty);
    const range = ranges[0];

    if (!this.editorView.hasFocus || !range) {
      this.hide();
      return;
    }

    const from = this.editorView.coordsAtPos(range.from, 1);
    const lastRange = ranges[ranges.length - 1];
    const to = this.editorView.coordsAtPos(lastRange.to, -1);
    const ownerWindow = this.editorView.dom.ownerDocument.defaultView;
    if (!from || !to || !ownerWindow) {
      this.hide();
      return;
    }

    this.toolbarEl.addClass("is-visible");
    const toolbarRect = this.toolbarEl.getBoundingClientRect();
    const selectionLeft = Math.min(from.left, to.left);
    const selectionRight = Math.max(from.right, to.right);
    const selectionTop = Math.min(from.top, to.top);
    const selectionBottom = Math.max(from.bottom, to.bottom);
    const preferredLeft = (selectionLeft + selectionRight - toolbarRect.width) / 2;
    const left = clamp(preferredLeft, 8, ownerWindow.innerWidth - toolbarRect.width - 8);
    const topAbove = selectionTop - toolbarRect.height - 8;
    const top = topAbove >= 8
      ? topAbove
      : Math.min(selectionBottom + 8, ownerWindow.innerHeight - toolbarRect.height - 8);
    this.toolbarEl.style.left = `${Math.round(left)}px`;
    this.toolbarEl.style.top = `${Math.round(top)}px`;
  }

  private hide(): void {
    this.toolbarEl.removeClass("is-visible");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
