export type ContextScopeMode = "current-file" | "files" | "folders" | "mixed" | "tags" | "rules";

export type ContextScope = {
  id: string;
  name: string;
  mode: ContextScopeMode;
  files: string[];
  folders: string[];
  tags: string[];
  pathRules: string[];
  excludeRules: string[];
  allowCloudModels: boolean;
};

export const SCOPE_MODE_LABELS: Record<ContextScopeMode, string> = {
  "current-file": "当前文件",
  "files": "指定文件",
  "folders": "文件夹",
  "mixed": "文件与文件夹",
  "tags": "标签",
  "rules": "路径规则",
};

export function scopeModeLabel(mode: ContextScopeMode): string {
  return SCOPE_MODE_LABELS[mode];
}
