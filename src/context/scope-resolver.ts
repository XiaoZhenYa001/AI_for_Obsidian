import { App, TFile } from "obsidian";
import { readFrontmatterTags } from "../utils/frontmatter";
import { isContextFile } from "../utils/context-files";
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
      const workspaceFile = this.app.workspace.getActiveFile();
      const activeFile = isContextFile(workspaceFile) ? workspaceFile : this.getCurrentFile?.();
      return isContextFile(activeFile) ? [activeFile] : [];
    }

    // Explicit selections scale with the selection, not the size of the vault.
    const contextFiles = scope.mode === "files" || (scope.mode === "mixed" && scope.folders.length === 0)
      ? Array.from(new Set(scope.files))
        .map((path) => this.app.vault.getAbstractFileByPath(path))
        .filter(isContextFile)
      : this.app.vault.getAllLoadedFiles().filter(isContextFile);
    const selectedPaths = new Set(scope.files);

    return contextFiles.filter((file) => {
      if (scope.excludeRules.some((rule) => file.path.includes(rule))) {
        return false;
      }

      if (scope.mode === "files") {
        return selectedPaths.has(file.path);
      }

      if (scope.mode === "folders") {
        return scope.folders.some((folder) => file.path.startsWith(`${folder.replace(/\/$/, "")}/`));
      }

      if (scope.mode === "mixed") {
        return selectedPaths.has(file.path) ||
          scope.folders.some((folder) => file.path.startsWith(`${folder.replace(/\/$/, "")}/`));
      }

      if (scope.mode === "tags") {
        if (file.extension !== "md") {
          return false;
        }

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
