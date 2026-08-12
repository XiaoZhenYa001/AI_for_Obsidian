const MERMAID_DIRECTIVE = /^(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?\b|^(?:sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|requirementDiagram|quadrantChart|block-beta|packet-beta|kanban)\b/i;
const GENERIC_CODE_LANGUAGES = new Set(["", "text", "plain", "plaintext", "code"]);

export function createMermaidMarkdown(source: string): string {
  return `\`\`\`mermaid\n${source.trim()}\n\`\`\``;
}

export function normalizeMermaidMarkdown(markdown: string): string {
  if (!markdown.trim()) return markdown;

  const normalizedFences = markdown.replace(
    /(^|\n)([ \t]{0,3})(`{3,}|~{3,})[ \t]*([^\r\n]*)\r?\n([\s\S]*?)\r?\n\2\3[ \t]*(?=\r?\n|$)/g,
    (block, prefix: string, indent: string, _fence: string, info: string, source: string) => {
      const language = info.trim().toLowerCase().split(/\s+/, 1)[0];
      if (!GENERIC_CODE_LANGUAGES.has(language) || !isMermaidSource(source)) return block;
      return `${prefix}${indent}${createMermaidMarkdown(source)}`;
    }
  );

  const trimmed = normalizedFences.trim();
  if (!trimmed.includes("```") && !trimmed.includes("~~~") && isMermaidSource(trimmed)) {
    const leading = normalizedFences.slice(0, normalizedFences.indexOf(trimmed));
    const trailing = normalizedFences.slice(normalizedFences.indexOf(trimmed) + trimmed.length);
    return `${leading}${createMermaidMarkdown(trimmed)}${trailing}`;
  }

  return normalizedFences;
}

export function isMermaidSource(source: string): boolean {
  const firstStatement = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("%%"));
  return Boolean(firstStatement && MERMAID_DIRECTIVE.test(firstStatement));
}
