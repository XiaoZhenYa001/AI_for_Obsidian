import "obsidian";
import { createChatComposer } from "../../src/chat/chat-composer";

const container = document.body.createDiv({ cls: "ai-second-brain-view composer-fixture" });
const events: Array<{ type: string; instruction?: string }> = [];
const composer = createChatComposer(container, {
  send: () => { events.push({ type: "send", instruction: composer.inputEl.value }); },
  editDrawing: (instruction) => { events.push({ type: "drawing", instruction }); },
  stop: () => { events.push({ type: "stop" }); }
});
(window as any).composerFixture = {
  events,
  setWidth(width: number) { container.style.width = `${width}px`; },
  setGenerating(value: boolean) {
    composer.sendButtonEl.style.display = value ? "none" : "";
    composer.stopButtonEl.style.display = value ? "" : "none";
  }
};
