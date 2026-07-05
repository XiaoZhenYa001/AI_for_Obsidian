export type PromptTemplateTask =
  | "selection-explain"
  | "selection-summarize"
  | "selection-rewrite"
  | "selection-translate"
  | "selection-expand"
  | "selection-condense";

export type PromptTemplateOutputMode = "append-block" | "replace-selection";

export type PromptTemplate = {
  id: string;
  name: string;
  task: PromptTemplateTask;
  prompt: string;
  providerId: string;
  model: string;
  contextScopeId: string;
  temperature?: number;
  useContext: boolean;
  outputMode: PromptTemplateOutputMode;
  builtIn: boolean;
};

export type PromptTemplateRenderInput = {
  selection: string;
  noteTitle?: string;
  filePath?: string;
};
