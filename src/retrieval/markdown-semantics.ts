import { parseYaml } from "obsidian";

export type PreparedContextDocument = {
  content: string;
  semanticContext: string;
};

export function prepareContextDocument(
  filePath: string,
  rawContent: string,
  incomingLinks: string[] = []
): PreparedContextDocument {
  if (filePath.toLowerCase().endsWith(".canvas")) {
    return prepareCanvasDocument(rawContent, incomingLinks);
  }

  if (filePath.toLowerCase().endsWith(".excalidraw")) {
    return prepareExcalidrawDocument(rawContent, incomingLinks);
  }

  return {
    content: rawContent,
    semanticContext: extractMarkdownSemantics(filePath, rawContent, incomingLinks)
  };
}

function extractMarkdownSemantics(filePath: string, content: string, incomingLinks: string[]): string {
  const frontmatter = readFrontmatter(content);
  const headings = Array.from(content.matchAll(/^(#{1,6})\s+(.+)$/gm))
    .map((match) => `${match[1].length}:${cleanInline(match[2])}`)
    .slice(0, 24);
  const embeds = uniqueMatches(content, /!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g);
  const links = uniqueMatches(content, /(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g);
  const tags = uniqueMatches(content, /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu);
  const callouts = uniqueMatches(content, /^>\s*\[!([^\]]+)\][+-]?(?:\s+.*)?$/gim);
  const tasks = Array.from(content.matchAll(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/gm));
  const openTasks = tasks.filter((match) => match[1] === " ").map((match) => cleanInline(match[2])).slice(0, 8);
  const blockQuoteCount = (content.match(/^>\s?(?!\[!)/gm) || []).length;
  const aliases = readStringArray(frontmatter.aliases ?? frontmatter.alias);
  const frontmatterTags = readStringArray(frontmatter.tags ?? frontmatter.tag).map((tag) => tag.replace(/^#/, ""));
  const properties = Object.entries(frontmatter)
    .map(([key, value]) => `${key}=${formatProperty(value)}`)
    .slice(0, 20);
  const isDailyNote = /(?:^|\/)\d{4}-\d{2}-\d{2}(?:\.md)?$/i.test(filePath) ||
    frontmatter.type === "daily" ||
    frontmatter.type === "daily-note";
  const isExcalidraw = /\.excalidraw\.md$/i.test(filePath) || frontmatter["excalidraw-plugin"] !== undefined;
  const excalidrawText = isExcalidraw ? extractExcalidrawMarkdownText(content) : [];
  const lines: string[] = [];

  if (isDailyNote) {
    lines.push("笔记类型：Daily Note");
  } else if (isExcalidraw) {
    lines.push("笔记类型：Excalidraw");
  }
  appendSummary(lines, "标题结构", headings);
  appendSummary(lines, "Properties", properties);
  appendSummary(lines, "别名", aliases);
  appendSummary(lines, "Tags", unique([...frontmatterTags, ...tags]));
  appendSummary(lines, "Wiki Links", links);
  appendSummary(lines, "反向链接", incomingLinks);
  appendSummary(lines, "嵌入内容", embeds);
  appendSummary(lines, "Callout", callouts);
  if (tasks.length > 0) {
    lines.push(`任务：${tasks.length} 项，未完成 ${openTasks.length} 项`);
    appendSummary(lines, "未完成任务", openTasks);
  }
  if (blockQuoteCount > 0) {
    lines.push(`块引用：${blockQuoteCount} 行`);
  }
  appendSummary(lines, "Excalidraw 文本元素", excalidrawText);
  return lines.join("\n");
}

function prepareCanvasDocument(content: string, incomingLinks: string[]): PreparedContextDocument {
  try {
    const canvas = JSON.parse(content) as {
      nodes?: Array<Record<string, unknown>>;
      edges?: Array<Record<string, unknown>>;
    };
    const nodes = (canvas.nodes || []).map((node, index) => {
      const id = readString(node.id) || `node-${index + 1}`;
      const type = readString(node.type) || "unknown";
      const label = readString(node.text) || readString(node.file) || readString(node.url) || readString(node.label);
      return `节点 ${id} [${type}]：${cleanInline(label) || "无文本"}`;
    });
    const edges = (canvas.edges || []).map((edge) => {
      const from = readString(edge.fromNode);
      const to = readString(edge.toNode);
      const label = readString(edge.label);
      return `关系：${from} -> ${to}${label ? `（${cleanInline(label)}）` : ""}`;
    });
    return {
      content: ["# Canvas 结构", "", ...nodes, "", ...edges].join("\n"),
      semanticContext: [
        "文件类型：Obsidian Canvas",
        `节点：${nodes.length} 个`,
        `关系：${edges.length} 条`,
        incomingLinks.length > 0 ? `反向链接：${incomingLinks.join("、")}` : ""
      ].filter(Boolean).join("\n")
    };
  } catch {
    return {
      content,
      semanticContext: "文件类型：Obsidian Canvas（JSON 解析失败，使用原始文本）"
    };
  }
}

function prepareExcalidrawDocument(content: string, incomingLinks: string[]): PreparedContextDocument {
  try {
    const drawing = JSON.parse(content) as {
      elements?: Array<Record<string, unknown>>;
    };
    const textElements = (drawing.elements || [])
      .filter((element) => element.type === "text")
      .map((element) => cleanInline(readString(element.text) || readString(element.originalText)))
      .filter(Boolean);
    return {
      content: ["# Excalidraw 文本元素", "", ...textElements.map((text) => `- ${text}`)].join("\n"),
      semanticContext: [
        "文件类型：Excalidraw",
        `文本元素：${textElements.length} 个`,
        incomingLinks.length > 0 ? `反向链接：${incomingLinks.join("、")}` : ""
      ].filter(Boolean).join("\n")
    };
  } catch {
    return {
      content,
      semanticContext: "文件类型：Excalidraw（JSON 解析失败，使用原始文本）"
    };
  }
}

function readFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    return {};
  }

  try {
    const parsed = parseYaml(match[1]) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractExcalidrawMarkdownText(content: string): string[] {
  const startMatch = /^##\s+Text Elements\s*$/im.exec(content);
  if (!startMatch) {
    return [];
  }

  const sectionStart = startMatch.index + startMatch[0].length;
  const remainder = content.slice(sectionStart);
  const nextSection = /^##\s+/m.exec(remainder);
  const section = nextSection ? remainder.slice(0, nextSection.index) : remainder;
  return section
    .split(/\r?\n/)
    .map((line) => cleanInline(line.replace(/\s*\^\w+\s*$/, "")))
    .filter(Boolean)
    .slice(0, 20);
}

function uniqueMatches(content: string, pattern: RegExp): string[] {
  return unique(Array.from(content.matchAll(pattern)).map((match) => cleanInline(match[1])).filter(Boolean)).slice(0, 20);
}

function appendSummary(lines: string[], label: string, values: string[]): void {
  if (values.length > 0) {
    lines.push(`${label}：${values.join("、")}`);
  }
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => cleanInline(String(item))).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,\n]/).map(cleanInline).filter(Boolean);
  }
  return [];
}

function formatProperty(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(String).join(", ").slice(0, 160);
  }
  if (isRecord(value)) {
    return JSON.stringify(value).slice(0, 160);
  }
  return cleanInline(String(value ?? "")).slice(0, 160);
}

function cleanInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
