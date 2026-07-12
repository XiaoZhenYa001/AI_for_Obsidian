import { Editor, EditorPosition } from "obsidian";

export type EditorChangeResult =
  | { applied: true }
  | { applied: false; reason: string };

export class EditorChangeTransaction {
  private constructor(
    private readonly editor: Editor,
    private readonly filePath: string,
    private readonly from: EditorPosition,
    private readonly to: EditorPosition,
    private readonly documentSnapshot: string
  ) {}

  static captureSelection(editor: Editor, filePath: string): EditorChangeTransaction | undefined {
    if (!editor.somethingSelected()) {
      return undefined;
    }

    return new EditorChangeTransaction(
      editor,
      filePath,
      copyPosition(editor.getCursor("from")),
      copyPosition(editor.getCursor("to")),
      editor.getValue()
    );
  }

  static captureInsertion(editor: Editor, filePath: string): EditorChangeTransaction {
    const cursor = copyPosition(editor.getCursor());
    return new EditorChangeTransaction(editor, filePath, cursor, cursor, editor.getValue());
  }

  apply(replacement: string, currentFilePath: string | undefined): EditorChangeResult {
    if (!currentFilePath || currentFilePath !== this.filePath) {
      return {
        applied: false,
        reason: "原笔记已经不是当前可编辑笔记。请返回原笔记后重新执行此操作。"
      };
    }

    if (this.editor.getValue() !== this.documentSnapshot) {
      return {
        applied: false,
        reason: "笔记内容在 AI 处理期间发生了变化。为避免覆盖新内容，本次修改未应用。"
      };
    }

    this.editor.replaceRange(replacement, this.from, this.to);
    return { applied: true };
  }
}

function copyPosition(position: EditorPosition): EditorPosition {
  return { line: position.line, ch: position.ch };
}
