import "./chat-workflow-harness";
import { MarkdownRenderer } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SelectionPreviewModal } from "../../src/ui/selection-preview-modal";
import { createSelectionToolbarExtension } from "../../src/ui/selection-toolbar";
import { enhanceMermaidArtifacts } from "../../src/ui/mermaid-artifact";

const renderMarkdown = MarkdownRenderer.render;
const pendingMarkdown: Array<() => void> = [];
let pauseMarkdown = false;
let markdownCalls = 0;
MarkdownRenderer.render = async (...args: Parameters<typeof MarkdownRenderer.render>) => {
  markdownCalls++;
  if (pauseMarkdown) await new Promise<void>(resolve => pendingMarkdown.push(resolve));
  await renderMarkdown(...args);
};

const fixture = {
  preview: undefined as SelectionPreviewModal | undefined,
  editor: undefined as EditorView | undefined,
  get markdownCalls() { return markdownCalls; },
  pauseMarkdown() { pauseMarkdown = true; },
  releaseMarkdown() {
    pauseMarkdown = false;
    pendingMarkdown.splice(0).forEach(resolve => resolve());
  },
  openPreview() {
    this.preview?.close();
    this.preview = new SelectionPreviewModal((window as any).chatFixture.plugin.app,
      { actionLabel: "改写", fileName: "审查.md", startLine: 1, before: "", original: "原选区", after: "" },
      () => {}, () => {}, () => {});
    this.preview.open();
  },
  openEditor() {
    this.editor?.destroy();
    const parent = document.body.createDiv();
    parent.style.cssText = "position:fixed;left:500px;top:20px;width:400px;height:200px";
    this.editor = new EditorView({ parent, state: EditorState.create({
      doc: "Keyboard selection stays instant.",
      extensions: [createSelectionToolbarExtension((window as any).chatFixture.plugin)]
    }) });
    this.editor.focus();
  }
};
(window as any).motionFixture = fixture;
(window as any).createMermaidFixture = () => {
  const root = document.body.createDiv();
  root.createDiv({ cls: "mermaid" });
  enhanceMermaidArtifacts(root, ["graph TD\nA-->B"]);
  return root;
};
