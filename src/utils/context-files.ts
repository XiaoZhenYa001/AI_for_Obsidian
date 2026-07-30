import { TAbstractFile, TFile } from "obsidian";

const CONTEXT_EXTENSIONS = new Set(["md", "canvas", "excalidraw"]);

export function isContextFile(file: TAbstractFile | null | undefined): file is TFile {
  return file instanceof TFile && CONTEXT_EXTENSIONS.has(file.extension.toLowerCase());
}

export function isContextFilePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.endsWith(".md") || normalized.endsWith(".canvas") || normalized.endsWith(".excalidraw");
}

