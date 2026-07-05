import { FuzzySuggestModal, Notice } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { ContextScope, scopeModeLabel } from "./scope-types";

export class ContextScopeSwitcherModal extends FuzzySuggestModal<ContextScope> {
  constructor(private readonly plugin: ObsidianAIPlugin) {
    super(plugin.app);
    this.setPlaceholder("选择 AI 可访问的上下文范围");
  }

  getItems(): ContextScope[] {
    return this.plugin.settings.contextScopes;
  }

  getItemText(scope: ContextScope): string {
    const count = this.plugin.countFilesInContextScope(scope);
    return `${scope.name} (${scopeModeLabel(scope.mode)} · ${count} 个文件)`;
  }

  async onChooseItem(scope: ContextScope): Promise<void> {
    await this.plugin.setActiveContextScope(scope.id);
    new Notice(`已切换上下文：${scope.name}`);
  }
}
