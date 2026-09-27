import { createIconButton } from "../ui/icon-button";

export interface ChatComposerActions {
  send: () => void;
  editDrawing: (instruction: string) => void;
  stop: () => void;
}

/** Shared by the chat view and its browser layout regression test. */
export function createChatComposer(container: HTMLElement, actions: ChatComposerActions) {
  const composerEl = container.createDiv({ cls: "ai-second-brain-composer" });
  const referencesEl = composerEl.createDiv({ cls: "ai-second-brain-composer-references" });
  const mainEl = composerEl.createDiv({ cls: "ai-second-brain-composer-main" });
  const inputEl = mainEl.createEl("textarea", {
    cls: "ai-second-brain-input",
    attr: {
      "aria-label": "对话输入",
      placeholder: "向你的笔记提问，或让 AI 帮你整理思路..."
    }
  });
  const actionsEl = mainEl.createDiv({ cls: "ai-second-brain-composer-actions" });
  const drawingButtonEl = createIconButton(actionsEl, "pencil-ruler", "编辑 Excalidraw 画布（也可输入 /draw 指令）", "ai-second-brain-composer-drawing");
  drawingButtonEl.addEventListener("click", () => actions.editDrawing(inputEl.value));
  const sendButtonEl = createIconButton(actionsEl, "send-horizontal", "发送", "ai-second-brain-send mod-cta");
  sendButtonEl.addEventListener("click", actions.send);
  const stopButtonEl = createIconButton(actionsEl, "square", "停止", "ai-second-brain-stop");
  stopButtonEl.style.display = "none";
  stopButtonEl.addEventListener("click", actions.stop);
  return { composerEl, referencesEl, inputEl, sendButtonEl, drawingButtonEl, stopButtonEl };
}
