import { DiagramDraft, DiagramNodeKind } from "./types";

type ExcalidrawAutomateApi = {
  reset(): void;
  setStrokeSharpness(value: number): unknown;
  setFontFamily(value: number): unknown;
  style: {
    strokeColor: string;
    backgroundColor: string;
    fillStyle: string;
    strokeWidth: number;
    roughness: number;
    opacity: number;
    fontSize: number;
    textAlign: string;
    verticalAlign: string;
  };
  canvas: {
    theme: string;
    viewBackgroundColor: string;
  };
  addText(
    x: number,
    y: number,
    text: string,
    formatting?: {
      wrapAt?: number;
      width?: number;
      height?: number;
      textAlign?: "left" | "center" | "right";
      box?: boolean | "box" | "ellipse" | "diamond";
      boxPadding?: number;
      boxStrokeColor?: string;
      textVerticalAlign?: "top" | "middle" | "bottom";
    }
  ): string;
  connectObjects(
    fromId: string,
    fromSide: "top" | "bottom" | "left" | "right" | null,
    toId: string,
    toSide: "top" | "bottom" | "left" | "right" | null,
    formatting?: {
      numberOfPoints?: number;
      startArrowHead?: "triangle" | "dot" | "arrow" | "bar" | null;
      endArrowHead?: "triangle" | "dot" | "arrow" | "bar" | null;
      padding?: number;
    }
  ): string;
  addLabelToLine(lineId: string, label: string): string | undefined;
  create(params?: {
    filename?: string;
    foldername?: string;
    onNewPane?: boolean;
    plaintext?: string;
    frontmatterKeys?: Record<string, string | number | boolean>;
  }): Promise<string>;
};

type WindowWithExcalidraw = Window & {
  ExcalidrawAutomate?: ExcalidrawAutomateApi;
};

export class ExcalidrawAdapter {
  isAvailable(): boolean {
    return Boolean(this.getApi());
  }

  async createDrawing(draft: DiagramDraft, folder: string): Promise<string> {
    const ea = this.getApi();

    if (!ea) {
      throw new Error("未检测到 Excalidraw 插件。请安装并启用 Excalidraw 后重试。");
    }

    ea.reset();

    try {
      this.applyCanvasStyle(ea);
      const elementIds = new Map<string, string>();

      for (const node of draft.layout.nodes) {
        this.applyNodeStyle(ea, node.kind);
        const text = node.sourcePath ? createWikiLinkedLabel(node.sourcePath, node.label) : node.label;
        const elementId = ea.addText(node.x, node.y, text, {
          width: node.width,
          height: node.height,
          wrapAt: node.kind === "primary" ? 16 : 18,
          textAlign: "center",
          textVerticalAlign: "middle",
          box: node.kind === "decision" ? "diamond" : node.kind === "primary" ? "ellipse" : "box",
          boxPadding: 14,
          boxStrokeColor: ea.style.strokeColor
        });
        elementIds.set(node.id, elementId);
      }

      this.applyEdgeStyle(ea);
      const fromSide = draft.layout.direction === "LR" ? "right" : "bottom";
      const toSide = draft.layout.direction === "LR" ? "left" : "top";

      for (const edge of draft.layout.edges) {
        const fromId = elementIds.get(edge.from);
        const toId = elementIds.get(edge.to);

        if (!fromId || !toId) {
          continue;
        }

        const lineId = ea.connectObjects(fromId, fromSide, toId, toSide, {
          numberOfPoints: 1,
          startArrowHead: null,
          endArrowHead: "arrow",
          padding: 10
        });

        if (edge.label) {
          ea.addLabelToLine(lineId, edge.label);
        }
      }

      const path = await ea.create({
        filename: sanitizeFilename(draft.spec.title),
        foldername: normalizeFolder(folder),
        onNewPane: true,
        plaintext: createDrawingMetadata(draft),
        frontmatterKeys: {
          "excalidraw-plugin": "parsed",
          "excalidraw-default-mode": "view"
        }
      });

      if (!path) {
        throw new Error("Excalidraw 没有返回新建文件路径。");
      }

      return path;
    } finally {
      ea.reset();
    }
  }

  private getApi(): ExcalidrawAutomateApi | undefined {
    return (window as WindowWithExcalidraw).ExcalidrawAutomate;
  }

  private applyCanvasStyle(ea: ExcalidrawAutomateApi): void {
    const dark = document.body.classList.contains("theme-dark");
    ea.canvas.theme = dark ? "dark" : "light";
    ea.canvas.viewBackgroundColor = dark ? "#1e1e1e" : "#ffffff";
    ea.setStrokeSharpness(0);
    ea.setFontFamily(2);
    ea.style.fillStyle = "solid";
    ea.style.strokeWidth = 1;
    ea.style.roughness = 0;
    ea.style.opacity = 100;
    ea.style.textAlign = "center";
    ea.style.verticalAlign = "middle";
  }

  private applyNodeStyle(ea: ExcalidrawAutomateApi, kind: DiagramNodeKind): void {
    const dark = document.body.classList.contains("theme-dark");
    const palette: Record<DiagramNodeKind, { stroke: string; background: string; fontSize: number }> = dark
      ? {
          primary: { stroke: "#a5b4fc", background: "#312e81", fontSize: 22 },
          secondary: { stroke: "#93c5fd", background: "#172554", fontSize: 18 },
          detail: { stroke: "#a7f3d0", background: "#064e3b", fontSize: 17 },
          decision: { stroke: "#fde68a", background: "#713f12", fontSize: 17 }
        }
      : {
          primary: { stroke: "#4f46e5", background: "#eef2ff", fontSize: 22 },
          secondary: { stroke: "#2563eb", background: "#eff6ff", fontSize: 18 },
          detail: { stroke: "#047857", background: "#ecfdf5", fontSize: 17 },
          decision: { stroke: "#a16207", background: "#fffbeb", fontSize: 17 }
        };
    const style = palette[kind];
    ea.style.strokeColor = style.stroke;
    ea.style.backgroundColor = style.background;
    ea.style.fontSize = style.fontSize;
  }

  private applyEdgeStyle(ea: ExcalidrawAutomateApi): void {
    const dark = document.body.classList.contains("theme-dark");
    ea.style.strokeColor = dark ? "#9ca3af" : "#64748b";
    ea.style.backgroundColor = "transparent";
    ea.style.strokeWidth = 1;
    ea.style.fontSize = 14;
  }
}

function createWikiLinkedLabel(path: string, label: string): string {
  const target = path.replace(/\.md$/i, "").replace(/\|/g, "");
  const alias = label.replace(/[\[\]|]/g, "");
  return `[[${target}|${alias}]]`;
}

function createDrawingMetadata(draft: DiagramDraft): string {
  const lines = [
    "由 AI Second Brain 生成。",
    "",
    `图谱类型：${draft.spec.type}`,
    `节点：${draft.spec.nodes.length}，关系：${draft.spec.edges.length}`
  ];

  if (draft.sourcePaths.length > 0) {
    lines.push("", "来源笔记：", ...draft.sourcePaths.map((path) => `- [[${path.replace(/\.md$/i, "")}]]`));
  }

  return lines.join("\n");
}

function normalizeFolder(value: string): string {
  const segments = value.replace(/\\/g, "/").split("/").map((segment) => segment.trim()).filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    return "AI Second Brain/Diagrams";
  }

  return segments.join("/");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|#^\[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "AI 知识图谱";
}
