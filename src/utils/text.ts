export function createExcerpt(content: string, maxLength = 220): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

export function countWords(content: string): number {
  const latinWords = content.match(/[a-zA-Z0-9_]+/g)?.length || 0;
  const cjkChars = content.match(/[\u3400-\u9fff\u{20000}-\u{2A6DF}\u3040-\u309F\u30A0-\u30FF]/gu)?.length || 0;
  return latinWords + cjkChars;
}
