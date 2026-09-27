import { App, FuzzySuggestModal, TFile } from "obsidian";

export class HtmlFilePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly choose: (file: TFile) => void) {
    super(app);
    this.setPlaceholder("选择要预览的 HTML 文件");
  }

  getItems(): TFile[] { return this.app.vault.getFiles().filter((file) => /\.html?$/i.test(file.path)); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}
