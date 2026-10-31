import { normalizePath, Notice, TFile, TFolder } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { KnowledgeHealthReport } from "../knowledge/types";
import { normalizeMermaidMarkdown } from "../utils/mermaid";
import { isExcalidrawFile } from "../diagrams/excalidraw-edit-service";

const AI_FOLDER = "AI Second Brain";

export class DraftManager {
  constructor(private readonly plugin: ObsidianAIPlugin) {}

  async createMocDraft(report?: KnowledgeHealthReport): Promise<void> {
    const healthReport = report || (await this.createHealthReport());

    if (!healthReport) {
      return;
    }

    try {
      await this.ensureFolder(AI_FOLDER);
      const content = this.plugin.knowledgeAnalysisService.generateMocDraft(healthReport);
      const path = this.createUniqueDraftPath(AI_FOLDER, "MOC");
      const file = await this.plugin.app.vault.create(path, content);
      await this.plugin.app.workspace.getLeaf(false).openFile(file);
      new Notice("MOC 草稿已生成。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`生成 MOC 失败：${message}`);
    }
  }

  async createReviewDraft(period: "daily" | "weekly"): Promise<void> {
    const healthReport = await this.createHealthReport();

    if (!healthReport) {
      return;
    }

    try {
      await this.ensureFolder(AI_FOLDER);
      const content = this.plugin.knowledgeAnalysisService.generateReviewDraft(healthReport, period);
      const path = this.createUniqueDraftPath(AI_FOLDER, period === "daily" ? "Daily Review" : "Weekly Review");
      const file = await this.plugin.app.vault.create(path, content);
      await this.plugin.app.workspace.getLeaf(false).openFile(file);
      new Notice(period === "daily" ? "每日回顾草稿已生成。" : "每周回顾草稿已生成。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`生成回顾草稿失败：${message}`);
    }
  }

  async createGeneratedNote(title: string, content: string, folderPath = AI_FOLDER): Promise<TFile> {
    const folder = normalizeGeneratedFolder(folderPath);
    await this.ensureFolder(folder);
    const prefix = sanitizeFilename(title || "Generated Note");
    const path = this.createUniqueDraftPath(folder, prefix);
    return this.plugin.app.vault.create(path, normalizeMermaidMarkdown(content));
  }

  async createHealthReport(): Promise<KnowledgeHealthReport | undefined> {
    const scope = this.plugin.getActiveContextScope();
    const files = this.plugin.contextScopeResolver.resolve(scope)
      .filter((file) => file.extension.toLowerCase() === "md" && !isExcalidrawFile(file, this.plugin.app));

    if (files.length === 0) {
      new Notice("当前上下文范围内没有可分析的 Markdown 文件。");
      return undefined;
    }

    return this.plugin.knowledgeAnalysisService.analyze(scope?.name || "当前上下文", files);
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const segments = folderPath.split("/").filter(Boolean);
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.plugin.app.vault.getAbstractFileByPath(currentPath);

      if (existing instanceof TFolder) {
        continue;
      }

      if (existing instanceof TFile) {
        throw new Error(`无法创建文件夹：${currentPath} 已经是一个文件。`);
      }

      await this.plugin.app.vault.createFolder(currentPath);
    }
  }

  private createUniqueDraftPath(folderPath: string, prefix: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    let path = `${folderPath}/${prefix} - ${timestamp}.md`;
    let index = 2;

    while (this.plugin.app.vault.getAbstractFileByPath(path)) {
      path = `${folderPath}/${prefix} - ${timestamp} ${index}.md`;
      index += 1;
    }

    return path;
  }
}

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim();
  return sanitized || "Generated Note";
}

function normalizeGeneratedFolder(value: string): string {
  const normalized = normalizePath(value.trim()).replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    return AI_FOLDER;
  }

  return segments.join("/");
}
