import type ObsidianAIPlugin from "../main";
import { AIProviderConfig } from "../providers/types";
import { Notice } from "obsidian";

export class ProviderManager {
  constructor(private readonly plugin: ObsidianAIPlugin) {}

  async add(provider: AIProviderConfig): Promise<void> {
    this.plugin.settings.providers.push(provider);

    if (!this.plugin.settings.defaultChatProviderId) {
      this.plugin.settings.defaultChatProviderId = provider.id;
    }

    if (!this.plugin.settings.defaultEditProviderId) {
      this.plugin.settings.defaultEditProviderId = provider.id;
    }

    await this.plugin.saveSettings();
  }

  async remove(providerId: string): Promise<void> {
    this.plugin.settings.providers = this.plugin.settings.providers.filter(
      (provider) => provider.id !== providerId
    );

    const fallbackProviderId = this.plugin.settings.providers.find((provider) => provider.enabled)?.id || "";

    if (this.plugin.settings.defaultChatProviderId === providerId) {
      this.plugin.settings.defaultChatProviderId = fallbackProviderId;
    }

    if (this.plugin.settings.defaultEditProviderId === providerId) {
      this.plugin.settings.defaultEditProviderId = fallbackProviderId;
    }

    await this.plugin.saveSettings();
    new Notice("AI 服务商已删除。");
  }
}
