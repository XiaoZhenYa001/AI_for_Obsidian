export type ProviderErrorCode =
  | "missing-api-key"
  | "missing-model"
  | "http-error"
  | "network-error"
  | "empty-response"
  | "invalid-response"
  | "stream-error"
  | "aborted";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function missingApiKey(providerName: string): ProviderError {
  return new ProviderError("missing-api-key", `Provider "${providerName}" is missing an API key.`);
}

export function missingModel(providerName: string): ProviderError {
  return new ProviderError("missing-model", `Provider "${providerName}" is missing a model name.`);
}

export function emptyResponse(providerName: string): ProviderError {
  return new ProviderError("empty-response", `Provider "${providerName}" returned an empty response.`);
}

export function httpError(providerName: string, status: number, message?: string): ProviderError {
  return new ProviderError(
    "http-error",
    message || `Provider "${providerName}" request failed with status ${status}.`,
    { status }
  );
}

export function invalidResponse(providerName: string, details?: unknown): ProviderError {
  return new ProviderError("invalid-response", `Provider "${providerName}" returned an invalid response.`, details);
}

export function streamError(message: string): ProviderError {
  return new ProviderError("stream-error", message);
}

export function normalizeProviderError(error: unknown, providerName: string): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return new ProviderError("aborted", "AI request was stopped.");
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("aborted", "AI request was stopped.");
  }

  if (error instanceof Error) {
    return new ProviderError("network-error", `Provider "${providerName}" request failed: ${error.message}`, error);
  }

  return new ProviderError("network-error", `Provider "${providerName}" request failed.`, error);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof ProviderError && error.code === "aborted") {
    return true;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  return error instanceof Error && error.name === "AbortError";
}
