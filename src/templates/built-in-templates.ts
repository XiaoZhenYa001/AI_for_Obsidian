import { PromptTemplate } from "./types";

export const BUILT_IN_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "selection-explain",
    name: "解释选中文本",
    task: "selection-explain",
    prompt: "请解释下面这段 Obsidian 笔记内容，要求清晰、简洁，并保留必要的上下文：\n\n{{selection}}",
    providerId: "",
    model: "",
    contextScopeId: "",
    useContext: false,
    outputMode: "append-block",
    builtIn: true
  },
  {
    id: "selection-summarize",
    name: "总结选中文本",
    task: "selection-summarize",
    prompt: "请总结下面这段 Obsidian 笔记内容，提炼关键要点，使用简洁的 Markdown 列表：\n\n{{selection}}",
    providerId: "",
    model: "",
    contextScopeId: "",
    useContext: false,
    outputMode: "append-block",
    builtIn: true
  },
  {
    id: "selection-rewrite",
    name: "改写选中文本",
    task: "selection-rewrite",
    prompt: "请润色并改写下面这段 Obsidian 笔记内容，保持原意，让表达更清晰自然。只输出改写后的正文：\n\n{{selection}}",
    providerId: "",
    model: "",
    contextScopeId: "",
    useContext: false,
    outputMode: "replace-selection",
    builtIn: true
  },
  {
    id: "selection-translate",
    name: "翻译选中文本",
    task: "selection-translate",
    prompt: "请将下面这段内容翻译成简体中文。如果原文已经是简体中文，则翻译成自然、准确的英文。只输出译文：\n\n{{selection}}",
    providerId: "",
    model: "",
    contextScopeId: "",
    useContext: false,
    outputMode: "replace-selection",
    builtIn: true
  },
  {
    id: "selection-expand",
    name: "扩写选中文本",
    task: "selection-expand",
    prompt: "请基于下面这段 Obsidian 笔记进行扩写，补充细节、逻辑和例子，保持 Markdown 格式。只输出扩写后的正文：\n\n{{selection}}",
    providerId: "",
    model: "",
    contextScopeId: "",
    useContext: false,
    outputMode: "replace-selection",
    builtIn: true
  },
  {
    id: "selection-condense",
    name: "缩写选中文本",
    task: "selection-condense",
    prompt: "请压缩下面这段 Obsidian 笔记，保留核心信息，去掉重复和赘述。只输出缩写后的正文：\n\n{{selection}}",
    providerId: "",
    model: "",
    contextScopeId: "",
    useContext: false,
    outputMode: "replace-selection",
    builtIn: true
  }
];
