import { DiagramNodeKind, DiagramSpec, DiagramType } from "./types";

const NODE_KINDS = new Set<DiagramNodeKind>(["primary", "secondary", "detail", "decision"]);

export function parseDiagramSpec(
  response: string,
  requestedType: DiagramType,
  allowedPaths: string[],
  maxNodes: number
): DiagramSpec {
  const parsed = JSON.parse(extractJsonObject(response)) as unknown;

  if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("AI 返回的图谱结构不完整，请重新生成。");
  }

  const allowedPathMap = new Map(allowedPaths.map((path) => [path.toLowerCase(), path]));
  const rawToNormalizedId = new Map<string, string>();
  const nodes = parsed.nodes.slice(0, maxNodes).flatMap((value, index) => {
    if (!isRecord(value)) {
      return [];
    }

    const label = readString(value.label).slice(0, 100);

    if (!label) {
      return [];
    }

    const rawId = readString(value.id) || `node-${index + 1}`;
    const id = createUniqueNodeId(rawId, index, new Set(rawToNormalizedId.values()));
    if (!rawToNormalizedId.has(rawId)) {
      rawToNormalizedId.set(rawId, id);
    }
    const rawKind = readString(value.kind) as DiagramNodeKind;
    const sourcePath = allowedPathMap.get(readString(value.sourcePath).toLowerCase());
    const sourceLineValue = typeof value.sourceLine === "number" ? Math.floor(value.sourceLine) : undefined;

    return [{
      id,
      label,
      kind: NODE_KINDS.has(rawKind) ? rawKind : index === 0 ? "primary" : "secondary",
      sourcePath,
      sourceLine: sourceLineValue && sourceLineValue > 0 ? sourceLineValue : undefined
    }];
  });

  if (nodes.length === 0) {
    throw new Error("AI 没有生成有效节点，请补充更具体的绘图目标后重试。");
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeKeys = new Set<string>();
  const edges = parsed.edges.slice(0, maxNodes * 3).flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }

    const from = rawToNormalizedId.get(readString(value.from));
    const to = rawToNormalizedId.get(readString(value.to));

    if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) {
      return [];
    }

    const key = `${from}->${to}`;

    if (edgeKeys.has(key)) {
      return [];
    }

    edgeKeys.add(key);
    const label = readString(value.label).slice(0, 50);
    return [{ from, to, label: label || undefined }];
  });

  return {
    title: readString(parsed.title).slice(0, 80) || "AI 知识图谱",
    type: requestedType,
    nodes,
    edges
  };
}

function extractJsonObject(value: string): string {
  const withoutFence = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");

  if (start === -1 || end <= start) {
    throw new Error("AI 没有返回可识别的图谱 JSON，请重新生成。");
  }

  return withoutFence.slice(start, end + 1);
}

function createUniqueNodeId(rawId: string, index: number, existing: Set<string>): string {
  const base = rawId.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || `node-${index + 1}`;
  let id = base;
  let suffix = 2;

  while (existing.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }

  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
