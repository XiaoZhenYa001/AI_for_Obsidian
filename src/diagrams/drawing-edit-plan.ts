export type DrawingElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  originalText?: string;
  rawText?: string;
  fontSize?: number;
  containerId?: string | null;
  boundElements?: Array<{ id: string; type: string }> | null;
  isDeleted?: boolean;
  [key: string]: unknown;
};

export type DrawingEdit = {
  type: "add-text" | "update-text";
  elementId?: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
};

export type DrawingEditPlan = { summary: string; edits: DrawingEdit[] };

export function parseDrawingEditPlan(response: string, elements: DrawingElement[]): DrawingEditPlan {
  const value = JSON.parse(response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
  if (!value || !Array.isArray(value.edits) || value.edits.length === 0 || value.edits.length > 24) {
    throw new Error("修改方案必须包含 1–24 项文本操作。");
  }
  const byId = new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element]));
  const updated = new Set<string>();
  const edits = value.edits.map((raw: unknown): DrawingEdit => {
    if (!raw || typeof raw !== "object") throw new Error("无法识别画布修改项。");
    const edit = raw as Record<string, unknown>;
    if (edit.type !== "add-text" && edit.type !== "update-text") throw new Error("仅支持添加或修改文本。");
    if (typeof edit.text !== "string" || !edit.text.trim() || edit.text.length > 16000) {
      throw new Error("每项文本需要 1–16000 个字符。");
    }
    let target = typeof edit.elementId === "string" ? byId.get(edit.elementId) : undefined;
    if (edit.type === "update-text") {
      if (target && target.type !== "text") {
        const texts = (target.boundElements || []).filter((bound) => bound.type === "text");
        target = texts.length === 1 ? byId.get(texts[0].id) : undefined;
      }
      if (!target || target.type !== "text") throw new Error("修改目标不是现有文本元素，请重新指定。");
      if (updated.has(target.id)) throw new Error("同一文本元素不能在一批中重复修改。");
      updated.add(target.id);
    }
    const fontSize = edit.fontSize === undefined ? target?.fontSize || 20 : Number(edit.fontSize);
    if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 120) throw new Error("字号必须在 8–120 之间。");
    let x = edit.x === undefined ? target?.x : edit.x;
    let y = edit.y === undefined ? target?.y : edit.y;
    if (edit.anchorId !== undefined) {
      const anchor = byId.get(String(edit.anchorId));
      if (!anchor) throw new Error("找不到定位参照元素。");
      const gap = edit.gap === undefined ? 24 : Number(edit.gap);
      if (!Number.isFinite(gap) || gap < 0 || gap > 10000) throw new Error("定位间距无效。");
      const width = Math.max(...edit.text.split("\n").map((line) => line.length), 1) * fontSize;
      const height = edit.text.split("\n").length * fontSize * 1.25;
      switch (edit.position) {
        case "below": x = anchor.x; y = anchor.y + anchor.height + gap; break;
        case "above": x = anchor.x; y = anchor.y - height - gap; break;
        case "right": x = anchor.x + anchor.width + gap; y = anchor.y; break;
        case "left": x = anchor.x - width - gap; y = anchor.y; break;
        case "inside": x = anchor.x + 12; y = anchor.y + 12; break;
        default: throw new Error("定位方向应为 below / above / left / right / inside。");
      }
    }
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1000000 || Math.abs(y) > 1000000) {
      throw new Error("请提供有效画布坐标，或选择现有元素作为定位参照。");
    }
    if (target?.containerId && (x !== target.x || y !== target.y)) {
      throw new Error("容器内的文字应保持原位置；需要新位置时请添加文本。");
    }
    return { type: edit.type, elementId: edit.type === "update-text" ? target!.id : undefined, text: edit.text, x, y, fontSize };
  });
  if (edits.reduce((total, edit) => total + edit.text.length, 0) > 60000) throw new Error("本次修改文本过长，请分批操作。");
  return { summary: typeof value.summary === "string" ? value.summary.slice(0, 500) : "画布文本修改", edits };
}

export function isDrawingEditRequest(content: string): boolean {
  const text = content.trim();
  if (/^\/draw(?:\s|$)/i.test(text)) return true;
  if (/[?？]|怎么|如何|能否|是否|为什么|哪些|什么|解释|分析|建议|值得/.test(text)) return false;
  return /^(?:(?:请|帮我|请帮我)\s*)?(?:在[\s\S]{1,120}?(?:添加|插入|写入|输入)|(?:把|将)[\s\S]+(?:改成|改为|替换为|放到|放在|移到)|(?:添加|插入|写入|修改|替换)[\s\S]+)/.test(text) ||
    /^(?:please\s+)?(?:add|insert|replace|update|move)\b/i.test(text);
}
