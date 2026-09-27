import { missingModel, streamError } from "./errors";
import { BaseProvider } from "./base-provider";
import { AIProviderConfig, ChatRequest, ChatStreamEvent } from "./types";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  error?: string;
};

const DEFAULT_BASE_URL = "http://localhost:11434";

export class OllamaProvider extends BaseProvider {
  constructor(config: AIProviderConfig) {
    super(config);
  }

  protected extractErrorMessage(data: unknown): string | undefined {
    const typed = data as OllamaChatResponse;
    return typed.error;
  }

  protected assertReady(model: string | undefined): void {
    if (!model) {
      throw missingModel(this.config.name);
    }
  }

  protected buildChatBody(request: ChatRequest, model: string): unknown {
    return {
      model,
      messages: request.messages,
      stream: false,
      options: {
        temperature: request.temperature ?? this.config.temperature,
      },
    };
  }

  protected buildStreamBody(request: ChatRequest, model: string): unknown {
    return {
      model,
      messages: request.messages,
      stream: true,
      options: {
        temperature: request.temperature ?? this.config.temperature,
      },
    };
  }

  protected extractContent(data: unknown): string | undefined {
    const typed = data as OllamaChatResponse;
    return typed.message?.content || undefined;
  }

  protected parseStreamEvent(eventText: string): ChatStreamEvent | "done" | undefined {
    return parseOllamaStreamLine(eventText);
  }

  protected getStreamUrl(): string {
    return `${this.baseUrl(DEFAULT_BASE_URL)}/api/chat`;
  }

  protected getChatUrl(): string {
    return `${this.baseUrl(DEFAULT_BASE_URL)}/api/chat`;
  }

  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
    };
  }
}

function parseOllamaStreamLine(line: string): ChatStreamEvent | "done" | undefined {
  const trimmed = line.trim();

  if (!trimmed) {
    return undefined;
  }

  const data = JSON.parse(trimmed) as {
    message?: {
      content?: string;
    };
    done?: boolean;
    error?: string;
  };

  if (data.error) {
    throw streamError(data.error);
  }

  if (data.done) {
    return "done";
  }

  return data.message?.content ? { type: "delta", content: data.message.content } : undefined;
}
