import { missingApiKey, missingModel } from "./errors";
import { BaseProvider } from "./base-provider";
import { AIProviderConfig, ChatRequest, ChatStreamEvent } from "./types";

type OpenAIChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAICompatibleProvider extends BaseProvider {
  constructor(config: AIProviderConfig) {
    super(config);
  }

  protected extractErrorMessage(data: unknown): string | undefined {
    const typed = data as OpenAIChatCompletion;
    return typed.error?.message;
  }

  protected assertReady(model: string | undefined): void {
    if (!this.config.apiKey) {
      throw missingApiKey(this.config.name);
    }

    if (!model) {
      throw missingModel(this.config.name);
    }
  }

  protected buildChatBody(request: ChatRequest, model: string): unknown {
    return {
      model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.temperature,
    };
  }

  protected buildStreamBody(request: ChatRequest, model: string): unknown {
    return {
      model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.temperature,
      stream: true,
    };
  }

  protected extractContent(data: unknown): string | undefined {
    const typed = data as OpenAIChatCompletion;
    return typed.choices?.[0]?.message?.content || undefined;
  }

  protected parseStreamEvent(eventText: string): ChatStreamEvent | "done" | undefined {
    return parseOpenAIStreamLine(eventText);
  }

  protected getStreamUrl(): string {
    return `${this.baseUrl(DEFAULT_BASE_URL)}/chat/completions`;
  }

  protected getChatUrl(): string {
    return `${this.baseUrl(DEFAULT_BASE_URL)}/chat/completions`;
  }

  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }
}

function parseOpenAIStreamLine(line: string): ChatStreamEvent | "done" | undefined {
  const trimmed = line.trim();

  if (!trimmed.startsWith("data:")) {
    return undefined;
  }

  const payload = trimmed.slice("data:".length).trim();

  if (!payload || payload === "[DONE]") {
    return payload === "[DONE]" ? "done" : undefined;
  }

  const data = JSON.parse(payload) as {
    choices?: Array<{
      delta?: {
        content?: string;
      };
    }>;
    error?: {
      message?: string;
    };
  };

  if (data.error?.message) {
    throw new Error(data.error.message);
  }

  const content = data.choices?.[0]?.delta?.content;

  return content ? { type: "delta", content } : undefined;
}
