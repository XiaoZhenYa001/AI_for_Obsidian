import { Editor, Notice } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { PromptTemplateTask } from "../templates/types";
import { SelectionPreviewModal } from "../ui/selection-preview-modal";
import { isAbortError } from "../providers/errors";
import { EditorChangeTransaction } from "./editor-change-transaction";

export type SelectionActionType = "explain" | "summarize" | "rewrite" | "translate" | "expand" | "condense";

const ACTION_TASKS: Record<SelectionActionType, PromptTemplateTask> = {
  explain: "selection-explain",
  summarize: "selection-summarize",
  rewrite: "selection-rewrite",
  translate: "selection-translate",
  expand: "selection-expand",
  condense: "selection-condense"
};

const ACTION_LABELS: Record<SelectionActionType, string> = {
  explain: "解释",
  summarize: "总结",
  rewrite: "改写",
  translate: "翻译",
  expand: "扩写",
  condense: "缩写"
};

export async function runSelectionAction(
  plugin: ObsidianAIPlugin,
  editor: Editor,
  action: SelectionActionType
): Promise<void> {
  const selection = editor.getSelection();

  if (!selection.trim()) {
    new Notice("请先选中需要处理的文本。");
    return;
  }

  const activeFile = plugin.getMarkdownViewForEditor(editor)?.file;
  const change = activeFile ? EditorChangeTransaction.captureSelection(editor, activeFile.path) : undefined;

  if (!change) {
    new Notice("无法锁定当前选区，请重新选择文本后再试。");
    return;
  }

  const template = plugin.templateService.findByTask(ACTION_TASKS[action]);

  if (!template) {
    new Notice(`找不到 ${ACTION_LABELS[action]} 模板。`);
    return;
  }

  const prompt = plugin.templateService.render(template, {
    selection,
    noteTitle: activeFile?.basename,
    filePath: activeFile?.path
  });
  const from = editor.getCursor("from");
  const to = editor.getCursor("to");
  const beforeStart = Math.max(0, from.line - 4);
  const afterEnd = Math.min(editor.lineCount() - 1, to.line + 4);
  const before = editor.getRange({ line: beforeStart, ch: 0 }, from);
  const after = editor.getRange(to, {
    line: afterEnd,
    ch: editor.getLine(afterEnd).length
  });

  const apply = (value: string, mode: "insert" | "replace"): boolean => {
    const replacement = mode === "insert"
      ? `${selection}\n\n${value}`
      : value;
    const result = change.apply(replacement, plugin.getMarkdownViewForEditor(editor)?.file?.path);

    if (!result.applied) {
      new Notice(result.reason);
      return false;
    }

    return true;
  };
  const abortController = new AbortController();
  const preview = new SelectionPreviewModal(plugin.app, {
    actionLabel: ACTION_LABELS[action],
    fileName: activeFile?.name || "当前笔记",
    startLine: from.line + 1,
    before,
    original: selection,
    after
  }, (value) => apply(value, "insert"), (value) => apply(value, "replace"), () => {
    abortController.abort();
  });
  preview.open();

  try {
    await waitForPaint();
    const response = await plugin.chatService.streamMessage(prompt, {
      useContext: template.useContext,
      providerId: template.providerId || plugin.settings.defaultEditProviderId,
      model: template.model,
      temperature: template.temperature,
      contextScopeId: template.contextScopeId,
      signal: abortController.signal
    });

    for await (const delta of response.stream) {
      if (abortController.signal.aborted || preview.isClosed()) {
        return;
      }
      preview.appendDelta(delta);
    }
    preview.complete();
  } catch (error) {
    if (isAbortError(error) || abortController.signal.aborted || preview.isClosed()) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    preview.fail("生成失败");
    new Notice(`AI ${ACTION_LABELS[action]}失败：${message}`);
  }
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
