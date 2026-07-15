import { Citation } from "../retrieval/types";

export type DiagramType =
  | "mind-map"
  | "flowchart"
  | "timeline"
  | "knowledge-map"
  | "architecture"
  | "decision-tree";
export type DiagramDirection = "LR" | "TB";
export type DiagramSourceMode = "selection" | "current-file" | "context";
export type DiagramNodeKind = "primary" | "secondary" | "detail" | "decision";

export type DiagramNode = {
  id: string;
  label: string;
  kind: DiagramNodeKind;
  sourcePath?: string;
  sourceLine?: number;
};

export type DiagramEdge = {
  from: string;
  to: string;
  label?: string;
};

export type DiagramSpec = {
  title: string;
  type: DiagramType;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};

export type PositionedDiagramNode = DiagramNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DiagramLayout = {
  direction: DiagramDirection;
  nodes: PositionedDiagramNode[];
  edges: DiagramEdge[];
};

export type DiagramDraft = {
  spec: DiagramSpec;
  layout: DiagramLayout;
  citations: Citation[];
  sourcePaths: string[];
};

export type GenerateDiagramOptions = {
  type: DiagramType;
  direction: DiagramDirection;
  sourceMode: DiagramSourceMode;
  selection?: string;
  sourceFilePath?: string;
  title?: string;
  focus?: string;
  sourceCitations?: Citation[];
  signal?: AbortSignal;
};

export const DIAGRAM_TYPE_LABELS: Record<DiagramType, string> = {
  "mind-map": "思维导图",
  flowchart: "流程图",
  timeline: "时间线",
  "knowledge-map": "概念关系图",
  architecture: "系统架构图",
  "decision-tree": "决策树"
};
