import { App, TFile } from "obsidian";
import { readFrontmatterTags } from "../utils/frontmatter";
import { ContextScope } from "./scope-types";

export class ContextScopeResolver {
  constructor(
    private readonly app: App,
    private readonly getCurrentFile?: () => TFile | undefined
  ) {}

  resolve(scope: ContextScope | undefined): TFile[] {
    if (!scope) {
      return [];
    }

    if (scope.mode === "current-file") {
      const activeFile = this.getCurrentFile?.() || this.app.workspace.getActiveFile() || undefined;
      return activeFile?.extension === "md" ? [activeFile] : [];
    }

    const markdownFiles = this.app.vault.getMarkdownFiles();

    return markdownFiles.filter((file) => {
      if (scope.excludeRules.some((rule) => file.path.includes(rule))) {
        return false;
      }

      if (scope.mode === "files") {
        return scope.files.includes(file.path);
      }

      if (scope.mode === "folders") {
        return scope.folders.some((folder) => file.path.startsWith(`${folder.replace(/\/$/, "")}/`));
      }

      if (scope.mode === "tags") {
        const cache = this.app.metadataCache.getFileCache(file);
        const tags = [
          ...(cache?.tags?.map((tag) => tag.tag.replace(/^#/, "")) || []),
          ...readFrontmatterTags(cache?.frontmatter?.tags)
        ];

        return scope.tags.some((tag) => tags.includes(tag.replace(/^#/, "")));
      }

      if (scope.mode === "rules") {
        return scope.pathRules.some((rule) => file.path.includes(rule));
      }

      return false;
    });
  }
}
