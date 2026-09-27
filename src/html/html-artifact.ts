import { App, TFile, TFolder } from "obsidian";

export function extractHtmlDocument(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})html[\t ]*$/i.exec(lines[index]);
    if (!opening) continue;
    const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[\\t ]*$`);
    for (let end = index + 1; end < lines.length; end += 1) {
      if (!closing.test(lines[end])) continue;
      const html = lines.slice(index + 1, end).join("\n").trim();
      if (html) return html;
      index = end;
      break;
    }
  }
  const trimmed = markdown.trim();
  if (/^(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)/i.test(trimmed) && /<\/html>\s*$/i.test(trimmed)) return trimmed;
  return undefined;
}

export async function saveHtmlArtifact(app: App, html: string): Promise<TFile> {
  for (const path of ["AI Second Brain", "AI Second Brain/HTML"]) {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) continue;
    if (existing) throw new Error(`${path} 已是文件，无法创建 HTML 目录。`);
    try {
      await app.vault.createFolder(path);
    } catch (error) {
      if (!(app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw error;
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return app.vault.create(`AI Second Brain/HTML/页面-${stamp}-${crypto.randomUUID().slice(0, 8)}.html`, html);
}
