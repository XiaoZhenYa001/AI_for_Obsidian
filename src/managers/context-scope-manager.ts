import type ObsidianAIPlugin from "../main";
import { ContextScope } from "../context/scope-types";
import { Notice } from "obsidian";

export const CURRENT_FILE_SCOPE_ID = "current-file";

export class ContextScopeManager {
  constructor(private readonly plugin: ObsidianAIPlugin) {}

  getActive(): ContextScope | undefined {
    return this.plugin.settings.contextScopes.find(
      (scope) => scope.id === this.plugin.settings.activeContextScopeId
    );
  }

  countFiles(scope: ContextScope | undefined): number {
    return this.plugin.contextScopeResolver.resolve(scope).length;
  }

  async setActive(scopeId: string): Promise<void> {
    if (!this.plugin.settings.contextScopes.some((scope) => scope.id === scopeId)) {
      return;
    }

    this.plugin.settings.activeContextScopeId = scopeId;
    await this.plugin.saveSettings();
  }

  async add(scope: ContextScope): Promise<void> {
    this.plugin.settings.contextScopes.push(scope);
    this.plugin.settings.activeContextScopeId = scope.id;
    await this.plugin.saveSettings();
  }

  async remove(scopeId: string): Promise<void> {
    if (scopeId === CURRENT_FILE_SCOPE_ID) {
      new Notice("当前文件范围不能删除。");
      return;
    }

    this.plugin.settings.contextScopes = this.plugin.settings.contextScopes.filter(
      (scope) => scope.id !== scopeId
    );

    if (this.plugin.settings.activeContextScopeId === scopeId) {
      this.plugin.settings.activeContextScopeId =
        this.plugin.settings.contextScopes[0]?.id || CURRENT_FILE_SCOPE_ID;
    }

    await this.plugin.saveSettings();
    new Notice("上下文范围已删除。");
  }
}
