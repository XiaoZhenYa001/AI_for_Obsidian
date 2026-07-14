import { graphlib, layout } from "@dagrejs/dagre";
import { DiagramDirection, DiagramLayout, DiagramSpec } from "./types";

export function layoutDiagram(spec: DiagramSpec, direction: DiagramDirection): DiagramLayout {
  const graph = new graphlib.Graph();
  graph.setGraph({
    rankdir: direction,
    ranksep: direction === "LR" ? 110 : 90,
    nodesep: 52,
    edgesep: 28,
    marginx: 40,
    marginy: 40,
    acyclicer: "greedy",
    ranker: "network-simplex"
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of spec.nodes) {
    const dimensions = measureNode(node.label, node.kind === "primary");
    graph.setNode(node.id, dimensions);
  }

  for (const edge of spec.edges) {
    graph.setEdge(edge.from, edge.to);
  }

  layout(graph);

  return {
    direction,
    nodes: spec.nodes.map((node) => {
      const position = graph.node(node.id);
      return {
        ...node,
        x: Math.round(position.x - position.width / 2),
        y: Math.round(position.y - position.height / 2),
        width: Math.round(position.width),
        height: Math.round(position.height)
      };
    }),
    edges: spec.edges
  };
}

function measureNode(label: string, primary: boolean): { width: number; height: number } {
  const charactersPerLine = primary ? 16 : 18;
  const estimatedLines = Math.max(1, Math.ceil(label.length / charactersPerLine));
  return {
    width: primary ? 250 : 220,
    height: Math.min(primary ? 118 : 110, 54 + estimatedLines * 19)
  };
}
