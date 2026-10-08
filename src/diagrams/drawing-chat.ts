import { DrawingEditPlan } from "./drawing-edit-plan";
import { DrawingSnapshot } from "./excalidraw-edit-service";

export function formatDrawingPreview(snapshot: DrawingSnapshot, plan: DrawingEditPlan): string {
  const elements = new Map(snapshot.elements.map(element => [element.id, element]));
  const edits = plan.edits.map(edit => {
    const original = edit.elementId ? elements.get(edit.elementId) : undefined;
    const before = original?.rawText || original?.originalText || original?.text || "";
    return edit.type === "update-text" ? `修改文本\n原文：${before}\n改为：${edit.text}` : `新增文本\n${edit.text}`;
  });
  return [`待写入 [[${snapshot.path}]]`, plan.summary, ...edits].join("\n\n");
}
