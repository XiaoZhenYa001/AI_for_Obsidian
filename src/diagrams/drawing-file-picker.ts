import { App, FuzzySuggestModal, TFile } from "obsidian";
import { isExcalidrawFile } from "./excalidraw-edit-service";

export function pickDrawingFile(app: App): Promise<TFile | undefined> {
  return new Promise(resolve => new DrawingFilePicker(app, resolve).open());
}

class DrawingFilePicker extends FuzzySuggestModal<TFile> {
  private settled = false;
  constructor(app: App, private readonly resolve: (file: TFile | undefined) => void) {
    super(app);
    this.setPlaceholder("选择要编辑的 Excalidraw 画布");
  }
  getItems(): TFile[] { return this.app.vault.getFiles().filter(file => isExcalidrawFile(file, this.app)); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.settled = true; this.resolve(file); }
  onClose(): void {
    super.onClose();
    // Obsidian may close the suggester before delivering onChooseItem.
    void Promise.resolve().then(() => { if (!this.settled) this.resolve(undefined); });
  }
}
