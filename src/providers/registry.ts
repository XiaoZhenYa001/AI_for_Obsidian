import { AIProvider, AIProviderConfig } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai-compatible";

export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();

  constructor(configs: AIProviderConfig[]) {
    this.update(configs);
  }

  update(configs: AIProviderConfig[]): void {
    this.providers.clear();

    for (const config of configs) {
      if (!config.enabled) {
        continue;
      }

      const provider = this.createProvider(config);

      if (provider) {
        this.providers.set(provider.id, provider);
      }
    }
  }

  get(providerId: string | undefined): AIProvider | undefined {
    if (!providerId) {
      return undefined;
    }

    return this.providers.get(providerId);
  }

  getFirstAvailable(): AIProvider | undefined {
    return this.providers.values().next().value;
  }

  private createProvider(config: AIProviderConfig): AIProvider | undefined {
    if (config.type === "openai-compatible") {
      return new OpenAICompatibleProvider(config);
    }

    if (config.type === "ollama") {
      return new OllamaProvider(config);
    }

    if (config.type === "anthropic") {
      return new AnthropicProvider(config);
    }

    return undefined;
  }
}
