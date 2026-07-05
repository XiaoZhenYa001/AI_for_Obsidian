import { missingApiKey, missingModel } from "./errors";
import { BaseProvider } from "./base-provider";
import { AIProviderConfig, ChatMessage, ChatRequest, ChatStreamEvent } from "./types";

type AnthropicContentBlock = {
  type: string;
  text?: string;
};

type AnthropicMessageResponse = {
  content?: AnthropicContentBlock[];
  error?: {
    message?: string;
  };
};

type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  system?: string;
  temperature?: number;
  stream?: boolean;
};

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicProvider extends BaseProvider {
  constructor(config: AIProviderConfig) {
    super(config);
  }

  protected extractErrorMessage(data: unknown): string | undefined {
    const typed = data as AnthropicMessageResponse;
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

  protected buildChatBody(request: ChatRequest, model: string): AnthropicRequestBody {
    return this.createBody(request, model, false);
  }

  protected buildStreamBody(request: ChatRequest, model: string): AnthropicRequestBody {
    return this.createBody(request, model, true);
  }

  protected extractContent(data: unknown): string | undefined {
    const typed = data as AnthropicMessageResponse;
    const text = readAnthropicText(typed.content || []);
    return text || undefined;
  }

  protected parseStreamEvent(eventText: string): ChatStreamEvent | "done" | undefined {
    return parseAnthropicStreamEvent(eventText);
  }

  protected getStreamUrl(): string {
    return `${this.baseUrl(DEFAULT_BASE_URL)}/messages`;
  }

  protected getChatUrl(): string {
    return `${this.baseUrl(DEFAULT_BASE_URL)}/messages`;
  }

  protected getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.apiKey || "",
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  protected getEventSeparator(): string {
    return "\r?\n\r?\n";
  }

  private createBody(request: ChatRequest, model: string, stream: boolean): AnthropicRequestBody {
    const { system, messages } = splitAnthropicMessages(request.messages);

    return {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages,
      system,
      temperature: request.temperature ?? this.config.temperature,
      stream,
    };
  }
}

function splitAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: AnthropicRequestBody["messages"];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const chatMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));

  return {
    system: system || undefined,
    messages: chatMessages.length > 0 ? chatMessages : [{ role: "user", content: "" }],
  };
}

function readAnthropicText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("")
    .trim();
}

function parseAnthropicStreamEvent(eventText: string): ChatStreamEvent | "done" | undefined {
  const dataLine = eventText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("data:"));

  if (!dataLine) {
    return undefined;
  }

  const payload = dataLine.slice("data:".length).trim();

  if (!payload) {
    return undefined;
  }

  const data = JSON.parse(payload) as {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
    };
    error?: {
      message?: string;
    };
  };

  if (data.type === "error") {
    throw new Error(data.error?.message || "Anthropic stream returned an error.");
  }

  if (data.type === "message_stop") {
    return "done";
  }

  if (data.type === "content_block_delta" && data.delta?.type === "text_delta" && data.delta.text) {
    return {
      type: "delta",
      content: data.delta.text,
    };
  }

  return undefined;
}
