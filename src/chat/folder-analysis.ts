import { App, TFile, TFolder } from "obsidian";
import { KnowledgeHealthReport } from "../knowledge/types";

export type FolderAnalysisIntent = {
  folderPaths: string[];
  files: TFile[];
  scopeName: string;
};

const ANALYSIS_TERMS = [
  "分析",
  "梳理",
  "总结",
  "解决方案",
  "建议",
  "关联",
  "重复",
  "冲突",
  "合并",
  "知识盲区"
];

export function detectFolderAnalysisIntent(app: App, query: string): FolderAnalysisIntent | undefined {
  if (!ANALYSIS_TERMS.some((term) => query.includes(term))) {
    return undefined;
  }

  const normalizedQuery = normalize(query);
  const folders = app.vault.getAllLoadedFiles()
    .filter((item): item is TFolder => item instanceof TFolder && Boolean(item.path))
    .map((folder) => ({ folder, score: scoreFolderMention(normalizedQuery, folder) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.folder.path.length - a.folder.path.length);

  if (folders.length === 0) {
    return undefined;
  }

  const bestScore = folders[0].score;
  const selectedFolders = folders
    .filter((item) => item.score === bestScore)
    .slice(0, 3)
    .map((item) => item.folder);
  const folderPaths = selectedFolders.map((folder) => folder.path);
  const files = app.vault.getMarkdownFiles()
    .filter((file) => folderPaths.some((path) => file.path.startsWith(`${path}/`)))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    return undefined;
  }

  return {
    folderPaths,
    files,
    scopeName: folderPaths.length === 1 ? folderPaths[0] : `${folderPaths.length} 个指定文件夹`
  };
}

export function buildFolderAnalysisInstruction(report: KnowledgeHealthReport): string {
  const noteInventory = report.notes.map((note) => {
    const links = note.outgoingLinks.length > 0 ? note.outgoingLinks.join("、") : "无";
    const tags = note.tags.length > 0 ? note.tags.map((tag) => `#${tag}`).join(" ") : "无";
    return `- ${note.path} | 标签：${tags} | 已有链接：${links} | 摘要：${note.excerpt || "无摘要"}`;
  });
  const linkSuggestions = report.linkSuggestions.slice(0, 30).map((item) =>
    `- ${item.sourcePath} -> ${item.targetPath}：${item.reason}`
  );
  const duplicateGroups = report.duplicateGroups.map((group) =>
    `- ${group.notes.map((note) => note.path).join("、")}：${group.reason}`
  );

  return [
    `用户明确要求分析「${report.scopeName}」中的全部 ${report.notes.length} 篇笔记。`,
    "请综合全部文件的结构摘要和检索片段回答用户的具体问题，不要只总结单篇笔记。",
    "回答必须包含：可执行解决方案、相关但尚未链接的笔记、建议插入的 [[双向链接]]、重复或冲突内容、缺少出处的观点、可以合并的笔记。",
    "所有链接建议必须使用实际文件路径构造 [[路径/文件名]]；区分笔记事实、跨笔记推断和你的建议。重要判断尽量使用 [1]、[2] 引用。",
    "如果资料不足以支持某项结论，明确标记为“证据不足”，不要补造出处。",
    "",
    "<folder_knowledge_inventory>",
    ...noteInventory,
    "",
    "本地检测到的潜在补链：",
    ...(linkSuggestions.length > 0 ? linkSuggestions : ["- 暂无确定项"]),
    "",
    "本地检测到的潜在重复：",
    ...(duplicateGroups.length > 0 ? duplicateGroups : ["- 暂无确定项"]),
    "</folder_knowledge_inventory>"
  ].join("\n");
}

function scoreFolderMention(query: string, folder: TFolder): number {
  const path = normalize(folder.path);
  const name = normalize(folder.name);
  if (query.includes(`${path}文件夹`) || query.includes(`${path}目录`)) {
    return 10 + path.length;
  }
  if (query.includes(path)) {
    return 8 + path.length;
  }
  if (query.includes(`${name}文件夹`) || query.includes(`${name}目录`)) {
    return 6 + name.length;
  }
  return 0;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\\/g, "/").replace(/[“”"']/g, "").replace(/\s+/g, " ").trim();
}
