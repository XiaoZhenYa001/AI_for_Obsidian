import { App, Modal, Notice, setIcon, TFile } from "obsidian";

const MAX_RENDERED_FILES = 200;

export class AuthorizedFilesModal extends Modal {
  private listEl?: HTMLElement;
  private query = "";

  constructor(
    app: App,
    private readonly scopeName: string,
    private readonly files: TFile[]
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-scope-files-modal");

    const header = contentEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "shield-check");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: "已授权文件" });
    heading.createEl("p", {
      cls: "ai-second-brain-muted",
      text: `${this.scopeName} · ${this.files.length} 个 Markdown 文件`
    });

    const search = contentEl.createDiv({ cls: "ai-second-brain-scope-files-search" });
    const searchIcon = search.createSpan({ cls: "ai-second-brain-scope-files-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = search.createEl("input", {
      type: "search",
      placeholder: "按文件名或路径筛选",
      attr: { "aria-label": "筛选已授权文件" }
    });
    searchInput.addEventListener("input", () => {
      this.query = searchInput.value.trim().toLocaleLowerCase();
      this.renderFiles();
    });

    this.listEl = contentEl.createDiv({ cls: "ai-second-brain-scope-files-list" });
    this.renderFiles();
    window.setTimeout(() => searchInput.focus(), 0);
  }

  onClose(): void {
    this.listEl = undefined;
    this.contentEl.empty();
  }

  private renderFiles(): void {
    if (!this.listEl) {
      return;
    }

    this.listEl.empty();
    const files = this.files
      .filter((file) => !this.query || file.path.toLocaleLowerCase().includes(this.query))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));

    if (files.length === 0) {
      const empty = this.listEl.createDiv({ cls: "ai-second-brain-scope-files-empty" });
      const icon = empty.createDiv({ cls: "ai-second-brain-scope-files-empty-icon" });
      setIcon(icon, "file-search");
      empty.createDiv({ text: this.query ? "没有匹配的授权文件" : "当前范围没有授权文件" });
      return;
    }

    for (const file of files.slice(0, MAX_RENDERED_FILES)) {
      const row = this.listEl.createEl("button", {
        cls: "ai-second-brain-scope-files-item",
        attr: {
          type: "button",
          title: file.path,
          "aria-label": `打开 ${file.path}`
        }
      });
      const fileIcon = row.createSpan({ cls: "ai-second-brain-scope-files-item-icon" });
      setIcon(fileIcon, "file-text");
      const copy = row.createSpan({ cls: "ai-second-brain-scope-files-item-copy" });
      copy.createSpan({ cls: "ai-second-brain-scope-files-item-name", text: file.name });
      copy.createSpan({ cls: "ai-second-brain-scope-files-item-path", text: getParentPath(file.path) });
      const openIcon = row.createSpan({ cls: "ai-second-brain-scope-files-item-open" });
      setIcon(openIcon, "arrow-up-right");
      row.addEventListener("click", () => {
        void this.openFile(file);
      });
    }

    if (files.length > MAX_RENDERED_FILES) {
      this.listEl.createDiv({
        cls: "ai-second-brain-scope-files-limit",
        text: `仅显示前 ${MAX_RENDERED_FILES} 个结果，请继续输入关键词缩小范围`
      });
    }
  }

  private async openFile(file: TFile): Promise<void> {
    const current = this.app.vault.getAbstractFileByPath(file.path);

    if (!(current instanceof TFile)) {
      new Notice("该文件已不存在，授权列表将在重新打开后刷新。");
      return;
    }

    try {
      await this.app.workspace.getLeaf(false).openFile(current);
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`无法打开文件：${message}`);
    }
  }
}

function getParentPath(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/") || "Vault 根目录";
}
