import { App, TFile } from "obsidian";
import { readFrontmatterTags } from "../utils/frontmatter";
import { countWords } from "../utils/text";
import {
  DuplicateGroup,
  KnowledgeHealthReport,
  KnowledgeNote,
  LinkSuggestion,
  TagStat
} from "./types";

export class KnowledgeAnalysisService {
  private cachedReport?: {
    signature: string;
    report: KnowledgeHealthReport;
  };

  constructor(private readonly app: App) {}

  async analyze(scopeName: string, files: TFile[]): Promise<KnowledgeHealthReport> {
    const signature = createAnalysisSignature(scopeName, files);
    if (this.cachedReport?.signature === signature) {
      return this.cachedReport.report;
    }

    const pathSet = new Set(files.map((file) => file.path));
    const incomingMap = this.buildIncomingLinkMap(pathSet);
    const contents = await Promise.all(files.map((file) => this.app.vault.cachedRead(file)));
    const contentCache = new Map(files.map((file, index) => [file.path, contents[index].toLowerCase()]));
    const notes: KnowledgeNote[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const content = contents[i];
      const cache = this.app.metadataCache.getFileCache(file);
      const outgoingLinks = Object.keys(this.app.metadataCache.resolvedLinks[file.path] || {}).filter((path) =>
        pathSet.has(path)
      );
      const tags = [
        ...(cache?.tags?.map((tag) => tag.tag.replace(/^#/, "")) || []),
        ...readFrontmatterTags(cache?.frontmatter?.tags)
      ];

      notes.push({
        path: file.path,
        title: readTitle(file, cache?.frontmatter?.title),
        folder: readFolder(file.path),
        tags: unique(tags),
        outgoingLinks,
        incomingLinks: incomingMap.get(file.path) || [],
        wordCount: countWords(content),
        modifiedTime: file.stat.mtime,
        excerpt: createNoteExcerpt(content),
        hasFrontmatter: Boolean(cache?.frontmatter),
        hasSummary: hasSummary(content, cache?.frontmatter)
      });
    }

    const report: KnowledgeHealthReport = {
      scopeName,
      generatedAt: new Date().toISOString(),
      notes,
      isolatedNotes: notes.filter((note) => note.outgoingLinks.length === 0 && note.incomingLinks.length === 0),
      missingFrontmatter: notes.filter((note) => !note.hasFrontmatter),
      missingSummary: notes.filter((note) => !note.hasSummary),
      duplicateGroups: findDuplicateGroups(notes),
      linkSuggestions: await this.findLinkSuggestions(notes, pathSet, contentCache),
      tagStats: buildTagStats(notes)
    };
    this.cachedReport = { signature, report };
    return report;
  }

  generateMocDraft(report: KnowledgeHealthReport): string {
    const folders = groupBy(report.notes, (note) => note.folder || "根目录");
    const lines: string[] = [
      "---",
      "type: moc",
      `scope: ${report.scopeName}`,
      `created: ${report.generatedAt}`,
      "---",
      "",
      `# ${report.scopeName} MOC`,
      "",
      "## 概览",
      "",
      `- 笔记数量：${report.notes.length}`,
      `- 孤立笔记：${report.isolatedNotes.length}`,
      `- 缺少摘要：${report.missingSummary.length}`,
      `- 潜在双链建议：${report.linkSuggestions.length}`,
      "",
      "## 高频标签",
      ""
    ];

    if (report.tagStats.length === 0) {
      lines.push("- 暂无标签");
    } else {
      for (const stat of report.tagStats.slice(0, 12)) {
        lines.push(`- #${stat.tag}：${stat.count}`);
      }
    }

    lines.push("", "## 笔记索引", "");

    for (const [folder, notes] of Array.from(folders.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### ${folder}`, "");

      for (const note of notes.sort((a, b) => a.title.localeCompare(b.title))) {
        const tags = note.tags.length > 0 ? ` ${note.tags.map((tag) => `#${tag}`).join(" ")}` : "";
        lines.push(`- ${toWikiLink(note.path, note.title)}${tags}`);
      }

      lines.push("");
    }

    lines.push("## 建议补链", "");

    if (report.linkSuggestions.length === 0) {
      lines.push("- 暂无明显建议");
    } else {
      for (const suggestion of report.linkSuggestions.slice(0, 20)) {
        lines.push(
          `- 在 ${toWikiLink(suggestion.sourcePath)} 中考虑链接到 ${toWikiLink(
            suggestion.targetPath,
            suggestion.targetTitle
          )}：${suggestion.reason}`
        );
      }
    }

    lines.push("", "## 待维护笔记", "");

    if (report.isolatedNotes.length === 0 && report.missingSummary.length === 0) {
      lines.push("- 暂无明显维护项");
    } else {
      for (const note of report.isolatedNotes.slice(0, 20)) {
        lines.push(`- 孤立笔记：${toWikiLink(note.path, note.title)}`);
      }

      for (const note of report.missingSummary.slice(0, 20)) {
        lines.push(`- 缺少摘要：${toWikiLink(note.path, note.title)}`);
      }
    }

    lines.push("");
    return lines.join("\n");
  }

  generateReviewDraft(report: KnowledgeHealthReport, period: "daily" | "weekly"): string {
    const now = new Date();
    const startTime = period === "daily" ? startOfToday(now).getTime() : startOfLastSevenDays(now).getTime();
    const changedNotes = report.notes
      .filter((note) => note.modifiedTime >= startTime)
      .sort((a, b) => b.modifiedTime - a.modifiedTime);
    const title = period === "daily" ? "每日回顾" : "每周回顾";
    const lines: string[] = [
      "---",
      `type: ${period}-review`,
      `scope: ${report.scopeName}`,
      `created: ${now.toISOString()}`,
      "---",
      "",
      `# ${title} - ${formatDate(now)}`,
      "",
      "## 更新概览",
      "",
      `- 当前上下文：${report.scopeName}`,
      `- 本次扫描笔记：${report.notes.length}`,
      `- 最近更新笔记：${changedNotes.length}`,
      `- 新发现补链建议：${report.linkSuggestions.length}`,
      "",
      "## 最近更新",
      ""
    ];

    if (changedNotes.length === 0) {
      lines.push("- 当前周期内没有发现修改过的授权笔记。");
    } else {
      for (const note of changedNotes.slice(0, 30)) {
        const excerpt = note.excerpt ? `：${note.excerpt}` : "";
        lines.push(`- ${toWikiLink(note.path, note.title)}${excerpt}`);
      }
    }

    lines.push("", "## 值得维护", "");

    for (const note of report.isolatedNotes.slice(0, 10)) {
      lines.push(`- 孤立笔记：${toWikiLink(note.path, note.title)}`);
    }

    for (const note of report.missingSummary.slice(0, 10)) {
      lines.push(`- 缺少摘要：${toWikiLink(note.path, note.title)}`);
    }

    if (report.isolatedNotes.length === 0 && report.missingSummary.length === 0) {
      lines.push("- 暂无明显维护项。");
    }

    lines.push("", "## 推荐补链", "");

    if (report.linkSuggestions.length === 0) {
      lines.push("- 暂无明显补链建议。");
    } else {
      for (const suggestion of report.linkSuggestions.slice(0, 10)) {
        lines.push(
          `- ${toWikiLink(suggestion.sourcePath)} → ${toWikiLink(suggestion.targetPath, suggestion.targetTitle)}：${
            suggestion.reason
          }`
        );
      }
    }

    lines.push("", "## 手动复盘", "", "- 今天/本周最重要的想法：", "- 可以继续展开的问题：", "- 下一步行动：", "");
    return lines.join("\n");
  }

  private buildIncomingLinkMap(pathSet: Set<string>): Map<string, string[]> {
    const incoming = new Map<string, string[]>();

    for (const [sourcePath, targetMap] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (!pathSet.has(sourcePath)) {
        continue;
      }

      for (const targetPath of Object.keys(targetMap)) {
        if (!pathSet.has(targetPath)) {
          continue;
        }

        const sources = incoming.get(targetPath) || [];
        sources.push(sourcePath);
        incoming.set(targetPath, sources);
      }
    }

    return incoming;
  }

  private async findLinkSuggestions(
    notes: KnowledgeNote[],
    pathSet: Set<string>,
    contentCache: Map<string, string>
  ): Promise<LinkSuggestion[]> {
    const suggestions: LinkSuggestion[] = [];
    const notesByPath = new Map(notes.map((note) => [note.path, note]));

    for (const source of notes) {
      let content = contentCache.get(source.path);

      if (content === undefined) {
        const sourceFile = this.app.vault.getAbstractFileByPath(source.path);

        if (!(sourceFile instanceof TFile)) {
          continue;
        }

        content = (await this.app.vault.cachedRead(sourceFile)).toLowerCase();
        contentCache.set(source.path, content);
      }

      const linked = new Set([...source.outgoingLinks, source.path]);

      for (const target of notes) {
        if (linked.has(target.path) || !pathSet.has(target.path)) {
          continue;
        }

        const sharedTags = target.tags.filter((tag) => source.tags.includes(tag));
        const titleMentioned = target.title.length >= 2 && content.includes(target.title.toLowerCase());
        const basenameMentioned = content.includes(readBasename(target.path).toLowerCase());

        if (!titleMentioned && !basenameMentioned && sharedTags.length < 2) {
          continue;
        }

        const score = (titleMentioned ? 5 : 0) + (basenameMentioned ? 3 : 0) + sharedTags.length;
        const targetNote = notesByPath.get(target.path);

        suggestions.push({
          sourcePath: source.path,
          targetPath: target.path,
          targetTitle: targetNote?.title || target.title,
          reason: titleMentioned || basenameMentioned ? "正文提到了目标笔记标题" : `共享标签：${sharedTags.join(", ")}`,
          score
        });
      }
    }

    return suggestions.sort((a, b) => b.score - a.score).slice(0, 50);
  }
}

function readTitle(file: TFile, frontmatterTitle: unknown): string {
  return typeof frontmatterTitle === "string" && frontmatterTitle.trim() ? frontmatterTitle.trim() : file.basename;
}

function createAnalysisSignature(scopeName: string, files: TFile[]): string {
  return [
    scopeName,
    ...files
      .map((file) => `${file.path}:${file.stat.mtime}:${file.stat.size}`)
      .sort()
  ].join("\n");
}

function readFolder(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || "根目录";
}

function readBasename(path: string): string {
  const filename = path.split("/").pop() || path;
  return filename.replace(/\.md$/i, "");
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function createNoteExcerpt(content: string): string {
  const body = content
    .replace(/^---[\s\S]*?---/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));

  if (!body) {
    return "";
  }

  return body.length > 120 ? `${body.slice(0, 120)}...` : body;
}

function hasSummary(content: string, frontmatter: Record<string, unknown> | undefined): boolean {
  if (frontmatter && typeof frontmatter.summary === "string" && frontmatter.summary.trim()) {
    return true;
  }

  return /^#{1,3}\s*(summary|摘要|总结|概览)\s*$/im.test(content);
}

function buildTagStats(notes: KnowledgeNote[]): TagStat[] {
  const counts = new Map<string, number>();

  for (const note of notes) {
    for (const tag of note.tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function findDuplicateGroups(notes: KnowledgeNote[]): DuplicateGroup[] {
  const byTitle = groupBy(notes, (note) => normalizeTitle(note.title));
  const groups: DuplicateGroup[] = [];

  for (const [, matchingNotes] of byTitle) {
    if (matchingNotes.length > 1) {
      groups.push({
        reason: "标题高度相似",
        notes: matchingNotes
      });
    }
  }

  return groups;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s_-]+/g, "").trim();
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

function toWikiLink(path: string, title?: string): string {
  const target = path.replace(/\.md$/i, "");
  return title ? `[[${target}|${title}]]` : `[[${target}]]`;
}

function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfLastSevenDays(now: Date): Date {
  const start = startOfToday(now);
  start.setDate(start.getDate() - 6);
  return start;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
