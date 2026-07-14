import { DiagramLayout, PositionedDiagramNode } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
let previewMarkerSequence = 0;

export function renderDiagramCanvas(container: HTMLElement, layout: DiagramLayout, title: string): void {
  const bounds = getBounds(layout.nodes);
  const shell = container.createDiv({ cls: "ai-second-brain-diagram-canvas" });
  const svg = createSvgElement("svg");
  const displayScale = 0.62;
  const markerId = `ai-second-brain-preview-arrow-${previewMarkerSequence += 1}`;
  svg.setAttribute("class", "ai-second-brain-diagram-canvas-svg");
  svg.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
  svg.setAttribute("width", `${Math.max(520, Math.round(bounds.width * displayScale))}`);
  svg.setAttribute("height", `${Math.max(210, Math.round(bounds.height * displayScale))}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${title}的布局预览`);
  shell.appendChild(svg);

  const defs = createSvgElement("defs");
  const marker = createSvgElement("marker");
  marker.setAttribute("id", markerId);
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "4");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "strokeWidth");
  const markerPath = createSvgElement("path");
  markerPath.setAttribute("d", "M 0 0 L 8 4 L 0 8 Z");
  marker.appendChild(markerPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const nodeMap = new Map(layout.nodes.map((node) => [node.id, node]));
  const edgesGroup = createSvgElement("g");
  edgesGroup.setAttribute("class", "ai-second-brain-diagram-canvas-edges");
  svg.appendChild(edgesGroup);

  for (const edge of layout.edges) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);

    if (!from || !to) {
      continue;
    }

    const geometry = getEdgeGeometry(from, to, layout.direction);
    const path = createSvgElement("path");
    path.setAttribute("d", geometry.path);
    path.setAttribute("class", "ai-second-brain-diagram-canvas-edge");
    path.setAttribute("marker-end", `url(#${markerId})`);
    edgesGroup.appendChild(path);

    if (edge.label) {
      const label = createSvgElement("text");
      label.setAttribute("class", "ai-second-brain-diagram-canvas-edge-label");
      label.setAttribute("x", `${geometry.labelX}`);
      label.setAttribute("y", `${geometry.labelY}`);
      label.setAttribute("text-anchor", "middle");
      label.textContent = edge.label;
      edgesGroup.appendChild(label);
    }
  }

  const nodesGroup = createSvgElement("g");
  nodesGroup.setAttribute("class", "ai-second-brain-diagram-canvas-nodes");
  svg.appendChild(nodesGroup);

  for (const node of layout.nodes) {
    const group = createSvgElement("g");
    group.setAttribute("class", `ai-second-brain-diagram-canvas-node is-${node.kind}`);
    group.setAttribute("transform", `translate(${node.x} ${node.y})`);
    const tooltip = createSvgElement("title");
    tooltip.textContent = node.sourcePath ? `${node.label}\n${node.sourcePath}` : node.label;
    group.appendChild(tooltip);
    group.appendChild(createNodeShape(node));
    appendNodeText(group, node);
    nodesGroup.appendChild(group);
  }
}

function createNodeShape(node: PositionedDiagramNode): SVGElement {
  if (node.kind === "primary") {
    const ellipse = createSvgElement("ellipse");
    ellipse.setAttribute("cx", `${node.width / 2}`);
    ellipse.setAttribute("cy", `${node.height / 2}`);
    ellipse.setAttribute("rx", `${node.width / 2}`);
    ellipse.setAttribute("ry", `${node.height / 2}`);
    return ellipse;
  }

  if (node.kind === "decision") {
    const diamond = createSvgElement("polygon");
    diamond.setAttribute(
      "points",
      `${node.width / 2},0 ${node.width},${node.height / 2} ${node.width / 2},${node.height} 0,${node.height / 2}`
    );
    return diamond;
  }

  const rect = createSvgElement("rect");
  rect.setAttribute("width", `${node.width}`);
  rect.setAttribute("height", `${node.height}`);
  rect.setAttribute("rx", "8");
  return rect;
}

function appendNodeText(group: SVGGElement, node: PositionedDiagramNode): void {
  const text = createSvgElement("text");
  text.setAttribute("class", "ai-second-brain-diagram-canvas-node-label");
  text.setAttribute("x", `${node.width / 2}`);
  text.setAttribute("y", `${node.height / 2}`);
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "middle");
  const lines = splitLabel(node.label, node.kind === "primary" ? 14 : 16, 3);
  const lineHeight = 18;
  const startOffset = -((lines.length - 1) * lineHeight) / 2;

  for (const [index, line] of lines.entries()) {
    const span = createSvgElement("tspan");
    span.setAttribute("x", `${node.width / 2}`);
    span.setAttribute("dy", index === 0 ? `${startOffset}` : `${lineHeight}`);
    span.textContent = line;
    text.appendChild(span);
  }

  group.appendChild(text);
}

function getBounds(nodes: PositionedDiagramNode[]): { x: number; y: number; width: number; height: number } {
  if (nodes.length === 0) {
    return { x: 0, y: 0, width: 520, height: 210 };
  }

  const padding = 30;
  const minX = Math.min(...nodes.map((node) => node.x)) - padding;
  const minY = Math.min(...nodes.map((node) => node.y)) - padding;
  const maxX = Math.max(...nodes.map((node) => node.x + node.width)) + padding;
  const maxY = Math.max(...nodes.map((node) => node.y + node.height)) + padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}

function getEdgeGeometry(
  from: PositionedDiagramNode,
  to: PositionedDiagramNode,
  direction: DiagramLayout["direction"]
): { path: string; labelX: number; labelY: number } {
  if (direction === "LR") {
    const startX = from.x + from.width;
    const startY = from.y + from.height / 2;
    const endX = to.x;
    const endY = to.y + to.height / 2;
    const curve = Math.max(42, Math.abs(endX - startX) / 2);
    return {
      path: `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`,
      labelX: (startX + endX) / 2,
      labelY: (startY + endY) / 2 - 7
    };
  }

  const startX = from.x + from.width / 2;
  const startY = from.y + from.height;
  const endX = to.x + to.width / 2;
  const endY = to.y;
  const curve = Math.max(36, Math.abs(endY - startY) / 2);
  return {
    path: `M ${startX} ${startY} C ${startX} ${startY + curve}, ${endX} ${endY - curve}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2 + 8,
    labelY: (startY + endY) / 2
  };
}

function splitLabel(value: string, maxCharacters: number, maxLines: number): string[] {
  const characters = Array.from(value.trim());
  const lines: string[] = [];

  while (characters.length > 0 && lines.length < maxLines) {
    const chunk = characters.splice(0, maxCharacters).join("");
    const isLastVisibleLine = lines.length === maxLines - 1 && characters.length > 0;
    lines.push(isLastVisibleLine ? `${chunk.slice(0, Math.max(1, chunk.length - 1))}…` : chunk);
  }

  return lines.length > 0 ? lines : ["未命名节点"];
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}
