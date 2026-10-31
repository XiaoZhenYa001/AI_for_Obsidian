import { App, Modal, Notice, setIcon } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { createIconButton } from "../ui/icon-button";
import { ModificationPlanModal } from "./modification-plan-modal";
import { investigateFiles } from "./file-agent";

export class FileAgentModal extends Modal {
  constructor(app: App, private readonly plugin: ObsidianAIPlugin) { super(app); }

  onOpen(): void {
    this.contentEl.addClass("ai-second-brain-modification-plan-modal");
    const header = this.contentEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "files");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: "AI 修改授权笔记" });
    heading.createEl("p", { cls: "ai-second-brain-muted", text: "AI 可在当前授权范围内查找和读取普通 Markdown 笔记，提出修改后由你预览确认。支持更新笔记，或在已读取笔记的文件夹中新建 Markdown；不执行终端命令。" });
    const input = this.contentEl.createEl("textarea", { attr: { placeholder: "描述要修改的内容，例如：将项目计划中的截止日期改为 11 月 30 日", "aria-label": "修改目标" } });
    input.rows = 5;
    input.style.width = "100%";
    const actions = this.contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    createIconButton(actions, "x", "取消").addEventListener("click", () => this.close());
    const start = createIconButton(actions, "search", "查找并生成修改", "mod-cta");
    start.addEventListener("click", () => {
      const objective = input.value.trim();
      if (!objective) { new Notice("请先描述修改目标。"); input.focus(); return; }
      this.close();
      new ModificationPlanModal(this.app, this.plugin, objective, [], signal => investigateFiles(this.plugin, objective, signal)).open();
    });
    input.focus();
  }
}
