import { App, Modal, Notice, setIcon, TFile } from "obsidian";
import { RelevantFile } from "../retrieval/text-search";
import { createIconButton } from "../ui/icon-button";

export type ContextSelectionResult = {
  selectedFilePaths: string[];
  lockedFilePaths: string[];
};

type ContextSelectionOptions = {
  scopeName: string;
  files: TFile[];
  relevantFiles: RelevantFile[];
  lockedFilePaths: string[];
};

const MAX_LOCKED_FILES = 8;

export function confirmContextSelection(
  app: App,
  options: ContextSelectionOptions
): Promise<ContextSelectionResult | undefined> {
  return new Promise((resolve) => {
    new ContextSelectionModal(app, options, resolve).open();
  });
}

class ContextSelectionModal extends Modal {
  private readonly selected = new Set<string>();
  private readonly locked = new Set<string>();
  private readonly relevance = new Map<string, RelevantFile>();
  private listEl?: HTMLElement;
  private summaryEl?: HTMLElement;
  private searchQuery = "";
  private settled = false;

  constructor(
    app: App,
    private readonly options: ContextSelectionOptions,
    private readonly resolveResult: (result: ContextSelectionResult | undefined) => void
  ) {
    super(app);

    for (const item of options.relevantFiles) {
      this.relevance.set(item.filePath, item);
      this.selected.add(item.filePath);
    }

    for (const path of options.lockedFilePaths) {
      if (options.files.some((file) => file.path === path)) {
        this.locked.add(path);
        this.selected.add(path);
      }
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-context-review-modal");
    this.modalEl.addClass("ai-second-brain-context-review-modal-shell");

    const header = contentEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "scan-search");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: "确认本轮上下文" });
    heading.createEl("p", {
      cls: "ai-second-brain-muted",
      text: `${this.options.scopeName} · 只会发送勾选文件中的相关片段`
    });

    const toolbar = contentEl.createDiv({ cls: "ai-second-brain-context-review-toolbar" });
    const searchIcon = toolbar.createSpan({ cls: "ai-second-brain-context-review-search-icon" });
    setIcon(searchIcon, "search");
    const search = toolbar.createEl("input", {
      type: "search",
      attr: { placeholder: "筛选授权文件", "aria-label": "筛选授权文件" }
    });
    search.addEventListener("input", () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderList();
    });

    this.summaryEl = contentEl.createDiv({ cls: "ai-second-brain-context-review-summary" });
    this.listEl = contentEl.createDiv({ cls: "ai-second-brain-context-review-list" });
    this.renderList();

    const actions = contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancelButton = createIconButton(actions, "x", "取消");
    cancelButton.addEventListener("click", () => this.close());
    const confirmButton = createIconButton(actions, "send-horizontal", "确认并发送", "mod-cta");
    confirmButton.addEventListener("click", () => {
      this.settled = true;
      this.resolveResult({
        selectedFilePaths: Array.from(this.selected),
        lockedFilePaths: Array.from(this.locked)
      });
      this.close();
    });
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(undefined);
    }

    this.contentEl.empty();
  }

  private renderList(): void {
    if (!this.listEl || !this.summaryEl) {
      return;
    }

    this.summaryEl.setText(`已选择 ${this.selected.size} 个文件 · 锁定 ${this.locked.size} 个`);
    this.listEl.empty();
    const files = [...this.options.files]
      .filter((file) => !this.searchQuery || file.path.toLowerCase().includes(this.searchQuery))
      .sort((a, b) => {
        const lockedDifference = Number(this.locked.has(b.path)) - Number(this.locked.has(a.path));
        if (lockedDifference !== 0) {
          return lockedDifference;
        }

        const scoreDifference = (this.relevance.get(b.path)?.score || 0) - (this.relevance.get(a.path)?.score || 0);
        return scoreDifference || a.path.localeCompare(b.path);
      });

    if (files.length === 0) {
      this.listEl.createDiv({ cls: "ai-second-brain-context-review-empty", text: "没有匹配的授权文件" });
      return;
    }

    for (const file of files) {
      const row = this.listEl.createDiv({ cls: "ai-second-brain-context-review-item" });
      row.dataset.filePath = file.path;
      row.toggleClass("is-selected", this.selected.has(file.path));
      row.toggleClass("is-locked", this.locked.has(file.path));

      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selected.has(file.path);
      checkbox.disabled = this.locked.has(file.path);
      checkbox.setAttribute("aria-label", `${checkbox.checked ? "取消选择" : "选择"} ${file.name}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selected.add(file.path);
        } else {
          this.selected.delete(file.path);
        }
        this.refreshSelectionState();
      });

      const copy = row.createDiv({ cls: "ai-second-brain-context-review-copy" });
      const titleRow = copy.createDiv({ cls: "ai-second-brain-context-review-title-row" });
      titleRow.createSpan({ cls: "ai-second-brain-context-review-name", text: file.name });
      const relevant = this.relevance.get(file.path);
      if (relevant) {
        titleRow.createSpan({
          cls: "ai-second-brain-context-review-match",
          text: relevant.matchedChunks > 1 ? `${relevant.matchedChunks} 处相关` : "相关"
        });
      }
      copy.createDiv({ cls: "ai-second-brain-context-review-path", text: file.path });

      const lockButton = createIconButton(
        row,
        this.locked.has(file.path) ? "pin-off" : "pin",
        this.locked.has(file.path) ? "取消锁定" : "锁定到当前对话",
        "ai-second-brain-context-review-lock"
      );
      lockButton.addEventListener("click", () => {
        if (this.locked.has(file.path)) {
          this.locked.delete(file.path);
        } else {
          if (this.locked.size >= MAX_LOCKED_FILES) {
            new Notice(`每个对话最多锁定 ${MAX_LOCKED_FILES} 个重要文件。`);
            return;
          }
          this.locked.add(file.path);
          this.selected.add(file.path);
        }
        this.refreshSelectionState();
      });
    }
  }

  private refreshSelectionState(): void {
    if (!this.listEl || !this.summaryEl) {
      return;
    }

    this.summaryEl.setText(`已选择 ${this.selected.size} 个文件 · 锁定 ${this.locked.size} 个`);

    for (const row of Array.from(this.listEl.querySelectorAll<HTMLElement>(".ai-second-brain-context-review-item"))) {
      const path = row.dataset.filePath;

      if (!path) {
        continue;
      }

      const isSelected = this.selected.has(path);
      const isLocked = this.locked.has(path);
      row.toggleClass("is-selected", isSelected);
      row.toggleClass("is-locked", isLocked);

      const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (checkbox) {
        checkbox.checked = isSelected;
        checkbox.disabled = isLocked;
        checkbox.setAttribute("aria-label", `${isSelected ? "取消选择" : "选择"} ${path}`);
      }

      const lockButton = row.querySelector<HTMLButtonElement>(".ai-second-brain-context-review-lock");
      if (lockButton) {
        const label = isLocked ? "取消锁定" : "锁定到当前对话";
        lockButton.title = label;
        lockButton.setAttribute("aria-label", label);
        lockButton.querySelector<HTMLElement>(".ai-second-brain-button-label")?.setText(label);
        const icon = lockButton.querySelector<HTMLElement>(".ai-second-brain-button-icon");
        if (icon) {
          setIcon(icon, isLocked ? "pin-off" : "pin");
        }
      }
    }
  }
}
