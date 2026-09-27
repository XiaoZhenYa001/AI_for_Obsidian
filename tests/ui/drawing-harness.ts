import { TFile } from "obsidian";
import { editDrawing } from "../../src/diagrams/edit-drawing-modal";
import { ExcalidrawEditService } from "../../src/diagrams/excalidraw-edit-service";

const file = new (TFile as any)("计划.excalidraw.md");
const view = { file, getViewType: () => "excalidraw" };
const state = { elements: [{ id: "title", type: "text", x: 100, y: 200, width: 150, height: 30, text: "项目计划", fontSize: 20 }], commits: 0, result: undefined as any };
const plugin: any = {
  settings: { defaultEditProviderId: "test" },
  getActiveContextScope: () => ({ allowCloudModels: false }),
  app: {
    metadataCache: { getFileCache: () => ({}) },
    vault: { getFiles: () => [file], getAbstractFileByPath: () => file },
    workspace: { getLeavesOfType: () => [{ view }] }
  },
  chatService: { sendMessage: async () => ({ content: JSON.stringify({ summary: "在标题下添加待办", edits: [{ type: "add-text", text: "准备周会", anchorId: "title", position: "below" }] }) }) }
};
plugin.excalidrawEditService = new ExcalidrawEditService(plugin, () => ({ getAPI() {
  const added: any[] = [];
  return {
    style: { fontSize: 20 }, getExcalidrawAPI: () => ({}), getViewElements: () => state.elements,
    getViewSelectedElements: () => [], destroy() {},
    addText(x: number, y: number, text: string) { added.push({ id: "new", type: "text", x, y, text }); return "new"; },
    async addElementsToView() { state.commits++; state.elements.push(...added); return true; }
  };
} } as any));
(window as any).drawingFixture = {
  state,
  async open(instruction = "在标题下面添加准备周会") { state.result = await editDrawing(plugin, instruction, file); },
  changeCanvas() { state.elements[0].text = "用户的新标题"; }
};
