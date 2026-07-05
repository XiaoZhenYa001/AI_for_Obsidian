export type AIProviderType = "openai-compatible" | "anthropic" | "ollama";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type AIProviderConfig = {
  id: string;
  name: string;
  type: AIProviderType;
  baseUrl?: string;
  apiKey?: string;
  defaultModel: string;
  temperature: number;
  stream: boolean;
  enabled: boolean;
};

export type ChatRequest = {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
};

export type ChatResponse = {
  content: string;
  raw?: unknown;
};

export type ChatStreamEvent = {
  type: "delta";
  content: string;
};

export interface AIProvider {
  readonly id: string;
  readonly config: AIProviderConfig;
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}
