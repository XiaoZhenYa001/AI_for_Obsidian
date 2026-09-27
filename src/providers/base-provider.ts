import {
  emptyResponse,
  httpError,
  invalidResponse,
  normalizeProviderError,
} from "./errors";
import {
  AIProvider,
  AIProviderConfig,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
} from "./types";

export abstract class BaseProvider implements AIProvider {
  readonly id: string;
  readonly config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.id = config.id;
    this.config = config;
  }

  // ── helpers shared by all providers ──────────────────────────────

  protected baseUrl(defaultUrl: string): string {
    return (this.config.baseUrl || defaultUrl).replace(/\/$/, "");
  }

  protected async readErrorBody(response: Response): Promise<string> {
    const text = await response.text();

    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      return (
        this.extractErrorMessage(data) ||
        `Provider request failed with status ${response.status}.`
      );
    } catch {
      return text || `Provider request failed with status ${response.status}.`;
    }
  }

  // ── abstract hooks subclasses must implement ─────────────────────

  protected abstract extractErrorMessage(data: unknown): string | undefined;
  protected abstract assertReady(model: string | undefined): void;
  protected abstract buildChatBody(
    request: ChatRequest,
    model: string,
  ): unknown;
  protected abstract buildStreamBody(
    request: ChatRequest,
    model: string,
  ): unknown;
  protected abstract extractContent(data: unknown): string | undefined;
  protected abstract parseStreamEvent(
    eventText: string,
  ): ChatStreamEvent | "done" | undefined;
  protected abstract getStreamUrl(): string;
  protected abstract getChatUrl(): string;
  protected abstract getHeaders(): Record<string, string>;

  // ── optional hooks with sensible defaults ────────────────────────

  protected getEventSeparator(): string {
    return "\r?\n";
  }

  // ── concrete chat() ──────────────────────────────────────────────

  async chat(request: ChatRequest): Promise<ChatResponse> {
    try {
      const model = request.model || this.config.defaultModel;
      this.assertReady(model);

      const response = await fetch(this.getChatUrl(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(this.buildChatBody(request, model)),
        signal: request.signal,
      });

      const responseText = await response.text();
      const data = parseResponseBody(responseText);

      if (!response.ok) {
        const providerMessage = data === undefined ? undefined : this.extractErrorMessage(data);
        throw httpError(
          this.config.name,
          response.status,
          providerMessage || compactErrorBody(responseText) || undefined,
        );
      }

      if (data === undefined) {
        throw invalidResponse(this.config.name, "Response body is not valid JSON.");
      }

      const content = this.extractContent(data);

      if (!content) {
        throw emptyResponse(this.config.name);
      }

      return {
        content,
        raw: data,
      };
    } catch (error) {
      throw normalizeProviderError(error, this.config.name);
    }
  }

  // ── concrete streamChat() ────────────────────────────────────────

  async *streamChat(request: ChatRequest): AsyncIterable<ChatStreamEvent> {
    try {
      const model = request.model || this.config.defaultModel;
      this.assertReady(model);

      const response = await fetch(this.getStreamUrl(), {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(this.buildStreamBody(request, model)),
        signal: request.signal,
      });

      if (!response.ok) {
        throw httpError(
          this.config.name,
          response.status,
          await this.readErrorBody(response),
        );
      }

      if (!response.body) {
        throw invalidResponse(this.config.name, "Missing response stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let hasContent = false;
      const separator = new RegExp(this.getEventSeparator());

      try {
        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            buffer += decoder.decode();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(separator);
          buffer = parts.pop() || "";

          for (const eventText of parts) {
            const event = this.parseStreamEvent(eventText);

            if (event === "done") {
              if (!hasContent) throw emptyResponse(this.config.name);
              return;
            }

            if (event) {
              hasContent = hasContent || Boolean(event.content);
              yield event;
            }
          }
        }

        // Process any residue remaining in the buffer after the loop.
        if (buffer.trim()) {
          const event = this.parseStreamEvent(buffer);

          if (event === "done") {
            if (!hasContent) throw emptyResponse(this.config.name);
            return;
          }

          if (event) {
            yield event;
          }
        }

        throw invalidResponse(this.config.name, "Response stream ended before its completion marker.");
      } finally {
        // Also release the network body when the caller stops consuming early.
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw invalidResponse(this.config.name, "Malformed response stream event.");
      }
      throw normalizeProviderError(error, this.config.name);
    }
  }
}

function parseResponseBody(value: string): unknown | undefined {
  if (!value.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function compactErrorBody(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}
