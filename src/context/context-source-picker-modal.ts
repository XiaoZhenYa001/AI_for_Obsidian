import { App, Modal, setIcon, TFile, TFolder } from "obsidian";
import { ContextScope } from "./scope-types";
import { createIconButton } from "../ui/icon-button";

export type ContextSourceSelection = {
  files: string[];
  folders: string[];
};

type BrowserItem = {
  type: "file" | "folder";
  name: string;
  path: string;
  folder?: TFolder;
};

export function pickContextSource(
  app: App,
  currentScope?: ContextScope
): Promise<ContextSourceSelection | undefined> {
  return new Promise((resolve) => {
    new ContextSourcePickerModal(app, currentScope, resolve).open();
  });
}

class ContextSourcePickerModal extends Modal {
  private currentFolder: TFolder;
  private readonly selectedFiles: Set<string>;
  private readonly selectedFolders: Set<string>;
  private readonly foldersWithMarkdown = new Set<string>();
  private query = "";
  private breadcrumbEl?: HTMLElement;
  private listEl?: HTMLElement;
  private summaryEl?: HTMLElement;
  private backButtonEl?: HTMLButtonElement;
  private confirmButtonEl?: HTMLButtonElement;
  private settled = false;

  constructor(
    app: App,
    currentScope: ContextScope | undefined,
    private readonly resolveResult: (result: ContextSourceSelection | undefined) => void
  ) {
    super(app);
    this.currentFolder = app.vault.getRoot();
    this.selectedFiles = new Set(currentScope?.mode === "current-file" ? [] : currentScope?.files || []);
    this.selectedFolders = new Set(currentScope?.mode === "current-file" ? [] : currentScope?.folders || []);

    for (const file of app.vault.getMarkdownFiles()) {
      let parent = file.parent;
      while (parent?.path) {
        this.foldersWithMarkdown.add(parent.path);
        parent = parent.parent;
      }
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-source-picker-modal");
    this.modalEl.addClass("ai-second-brain-source-picker-modal-shell");

    const header = contentEl.createDiv({ cls: "ai-second-brain-source-picker-header" });
    const heading = header.createDiv({ cls: "ai-second-brain-source-picker-heading" });
    heading.createEl("h2", { text: "选择文件与文件夹" });
    heading.createEl("p", { text: "所选内容仅用于当前对话" });
    this.summaryEl = header.createDiv({ cls: "ai-second-brain-source-picker-count" });

    const navigation = contentEl.createDiv({ cls: "ai-second-brain-source-picker-navigation" });
    this.backButtonEl = createIconButton(navigation, "arrow-left", "返回上一级", "ai-second-brain-source-picker-back");
    this.backButtonEl.addEventListener("click", () => this.goBack());
    this.breadcrumbEl = navigation.createDiv({ cls: "ai-second-brain-source-picker-breadcrumb" });

    const search = contentEl.createDiv({ cls: "ai-second-brain-source-picker-search" });
    const searchIcon = search.createSpan();
    setIcon(searchIcon, "search");
    const searchInput = search.createEl("input", {
      type: "search",
      attr: { placeholder: "筛选当前目录", "aria-label": "筛选当前目录" }
    });
    searchInput.addEventListener("input", () => {
      this.query = searchInput.value.trim().toLowerCase();
      this.renderList();
    });

    this.listEl = contentEl.createDiv({ cls: "ai-second-brain-source-picker-list" });

    const footer = contentEl.createDiv({ cls: "ai-second-brain-source-picker-footer" });
    const clearButton = createIconButton(footer, "list-x", "清除选择", "ai-second-brain-source-picker-clear");
    clearButton.addEventListener("click", () => {
      this.selectedFiles.clear();
      this.selectedFolders.clear();
      this.refreshSelectionState();
    });
    const actions = footer.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancelButton = actions.createEl("button", {
      cls: "ai-second-brain-source-picker-cancel",
      text: "取消",
      attr: { type: "button" }
    });
    cancelButton.addEventListener("click", () => this.close());
    this.confirmButtonEl = actions.createEl("button", {
      cls: "ai-second-brain-source-picker-confirm mod-cta",
      text: "确定",
      attr: { type: "button" }
    });
    this.confirmButtonEl.addEventListener("click", () => this.confirmSelection());

    this.render();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(undefined);
    }
    this.contentEl.empty();
  }

  private render(): void {
    this.renderBreadcrumb();
    this.renderList();
    this.updateSelectionSummary();
  }

  private renderBreadcrumb(): void {
    if (!this.breadcrumbEl || !this.backButtonEl) {
      return;
    }

    this.breadcrumbEl.empty();
    this.backButtonEl.disabled = !this.currentFolder.path;
    this.createBreadcrumbButton("根目录", "");

    const segments = this.currentFolder.path.split("/").filter(Boolean);
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      const separator = this.breadcrumbEl.createSpan({ cls: "ai-second-brain-source-picker-breadcrumb-separator" });
      setIcon(separator, "chevron-right");
      this.createBreadcrumbButton(segment, path);
    }
  }

  private createBreadcrumbButton(label: string, path: string): void {
    if (!this.breadcrumbEl) {
      return;
    }

    const button = this.breadcrumbEl.createEl("button", {
      text: label,
      attr: { type: "button", title: path || "根目录" }
    });
    button.toggleClass("is-current", path === this.currentFolder.path);
    button.addEventListener("click", () => this.openFolder(path));
  }

  private renderList(): void {
    if (!this.listEl) {
      return;
    }

    this.listEl.empty();

    if (this.currentFolder.path && !this.query) {
      this.renderCurrentFolderChoice();
    }

    const items = this.getCurrentItems();
    if (items.length === 0 && (!this.currentFolder.path || this.query)) {
      this.listEl.createDiv({
        cls: "ai-second-brain-source-picker-empty",
        text: this.query ? "当前目录没有匹配结果" : "当前目录没有 Markdown 文件或子文件夹"
      });
      return;
    }

    for (const item of items) {
      this.renderItem(item);
    }
  }

  private renderCurrentFolderChoice(): void {
    if (!this.listEl) {
      return;
    }

    const path = this.currentFolder.path;
    const row = this.listEl.createDiv({ cls: "ai-second-brain-source-picker-item is-current-folder" });
    row.dataset.contextType = "folder";
    row.dataset.contextPath = path;
    row.toggleClass("is-selected", this.selectedFolders.has(path));
    const copy = row.createDiv({ cls: "ai-second-brain-source-picker-current-copy" });
    const icon = copy.createSpan({ cls: "ai-second-brain-source-picker-item-icon" });
    setIcon(icon, "folder-check");
    copy.createSpan({ text: "选择当前文件夹" });
    this.createSelectionCheckbox(row, "folder", path, this.selectedFolders.has(path));
  }

  private renderItem(item: BrowserItem): void {
    if (!this.listEl) {
      return;
    }

    const selected = item.type === "file" ? this.selectedFiles.has(item.path) : this.selectedFolders.has(item.path);
    const row = this.listEl.createDiv({ cls: "ai-second-brain-source-picker-item" });
    row.dataset.contextType = item.type;
    row.dataset.contextPath = item.path;
    row.toggleClass("is-selected", selected);
    const main = row.createEl("button", { cls: "ai-second-brain-source-picker-item-main", attr: { type: "button" } });
    const icon = main.createSpan({ cls: "ai-second-brain-source-picker-item-icon" });
    setIcon(icon, item.type === "file" ? "file-text" : "folder");
    const copy = main.createSpan({ cls: "ai-second-brain-source-picker-item-copy" });
    copy.createSpan({ cls: "ai-second-brain-source-picker-item-name", text: item.name });
    copy.createSpan({ cls: "ai-second-brain-source-picker-item-path", text: item.type === "folder" ? "文件夹" : item.path });
    if (item.type === "folder") {
      const arrow = main.createSpan({ cls: "ai-second-brain-source-picker-item-state" });
      setIcon(arrow, "chevron-right");
      main.addEventListener("click", () => this.enterFolder(item.folder!));
    } else {
      main.addEventListener("click", () => this.toggleSelection("file", item.path));
    }
    this.createSelectionCheckbox(row, item.type, item.path, selected);
  }

  private createSelectionCheckbox(container: HTMLElement, type: BrowserItem["type"], path: string, checked: boolean): void {
    const checkbox = container.createEl("input", { type: "checkbox" });
    checkbox.checked = checked;
    checkbox.setAttribute("aria-label", `${checked ? "取消选择" : "选择"}${path}`);
    checkbox.addEventListener("change", () => this.toggleSelection(type, path));
  }

  private updateSelectionSummary(): void {
    const count = this.selectedFiles.size + this.selectedFolders.size;
    this.summaryEl?.setText(
      count === 0 ? "尚未选择" : `${count} 项 · ${this.selectedFiles.size} 个文件 · ${this.selectedFolders.size} 个文件夹`
    );
    if (this.confirmButtonEl) {
      this.confirmButtonEl.disabled = count === 0;
    }
  }

  private refreshSelectionState(): void {
    this.updateSelectionSummary();
    const rows = this.listEl
      ? Array.from(this.listEl.querySelectorAll<HTMLElement>(".ai-second-brain-source-picker-item"))
      : [];

    for (const row of rows) {
      const path = row.dataset.contextPath;
      const type = row.dataset.contextType;

      if (!path || (type !== "file" && type !== "folder")) {
        continue;
      }

      const selected = type === "file" ? this.selectedFiles.has(path) : this.selectedFolders.has(path);
      row.toggleClass("is-selected", selected);
      const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = selected;
        checkbox.setAttribute("aria-label", `${selected ? "取消选择" : "选择"}${path}`);
      }
    }
  }

  private getCurrentItems(): BrowserItem[] {
    return this.currentFolder.children
      .flatMap((item): BrowserItem[] => {
        if (item instanceof TFile && item.extension === "md") {
          return [{ type: "file", name: item.name, path: item.path }];
        }
        if (item instanceof TFolder && this.foldersWithMarkdown.has(item.path)) {
          return [{ type: "folder", name: item.name, path: item.path, folder: item }];
        }
        return [];
      })
      .filter((item) => !this.query || item.name.toLowerCase().includes(this.query) || item.path.toLowerCase().includes(this.query))
      .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1);
  }

  private toggleSelection(type: BrowserItem["type"], path: string): void {
    const target = type === "file" ? this.selectedFiles : this.selectedFolders;
    if (target.has(path)) {
      target.delete(path);
    } else {
      target.add(path);
    }
    this.refreshSelectionState();
  }

  private enterFolder(folder: TFolder): void {
    this.currentFolder = folder;
    this.query = "";
    const search = this.contentEl.querySelector<HTMLInputElement>(".ai-second-brain-source-picker-search input");
    if (search) {
      search.value = "";
    }
    this.render();
  }

  private openFolder(path: string): void {
    const folder = path ? this.app.vault.getAbstractFileByPath(path) : this.app.vault.getRoot();
    if (folder instanceof TFolder) {
      this.enterFolder(folder);
    }
  }

  private goBack(): void {
    if (!this.currentFolder.path) {
      return;
    }
    const parentPath = this.currentFolder.path.includes("/")
      ? this.currentFolder.path.slice(0, this.currentFolder.path.lastIndexOf("/"))
      : "";
    this.openFolder(parentPath);
  }

  private confirmSelection(): void {
    if (this.selectedFiles.size + this.selectedFolders.size === 0) {
      return;
    }
    this.settled = true;
    this.resolveResult({ files: Array.from(this.selectedFiles), folders: Array.from(this.selectedFolders) });
    this.close();
  }
}
