import { Editor, Notice } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { PromptTemplateTask } from "../templates/types";
import { DiffPreviewModal } from "../ui/diff-preview-modal";
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
  const selection = editor.getSelection().trim();

  if (!selection) {
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

  try {
    const response = await plugin.chatService.sendMessage(prompt, {
      useContext: template.useContext,
      providerId: template.providerId || plugin.settings.defaultEditProviderId,
      model: template.model,
      temperature: template.temperature,
      contextScopeId: template.contextScopeId
    });

    if (template.outputMode === "replace-selection") {
      new DiffPreviewModal(plugin.app, selection, response.content, (value) => {
        const result = change.apply(value, plugin.getMarkdownViewForEditor(editor)?.file?.path);

        if (!result.applied) {
          new Notice(result.reason);
          return false;
        }

        return true;
      }).open();
      return;
    }

    const result = change.apply(
      `${selection}\n\n> AI ${ACTION_LABELS[action]}：${response.content}`,
      plugin.getMarkdownViewForEditor(editor)?.file?.path
    );

    if (!result.applied) {
      new Notice(result.reason);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`AI ${ACTION_LABELS[action]}失败：${message}`);
  }
}
