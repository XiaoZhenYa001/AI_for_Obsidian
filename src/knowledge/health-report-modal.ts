import { App, Modal, Notice, TFile } from "obsidian";
import { KnowledgeHealthReport, KnowledgeNote, LinkSuggestion } from "./types";

export class KnowledgeHealthReportModal extends Modal {
  constructor(
    app: App,
    private readonly report: KnowledgeHealthReport,
    private readonly onCreateMoc: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-health-modal");

    const header = contentEl.createDiv({ cls: "ai-second-brain-health-header" });
    header.createEl("h2", { text: "知识库健康检查" });
    header.createEl("p", {
      cls: "ai-second-brain-muted",
      text: `${this.report.scopeName} · ${this.report.notes.length} 个文件`
    });

    const actions = contentEl.createDiv({ cls: "ai-second-brain-health-actions" });
    const mocButton = actions.createEl("button", { text: "生成 MOC 草稿", attr: { type: "button" } });
    mocButton.addEventListener("click", () => {
      void this.onCreateMoc().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`生成 MOC 失败：${message}`);
      });
      this.close();
    });

    const stats = contentEl.createDiv({ cls: "ai-second-brain-health-stats" });
    this.renderStat(stats, "孤立笔记", this.report.isolatedNotes.length);
    this.renderStat(stats, "缺 Front Matter", this.report.missingFrontmatter.length);
    this.renderStat(stats, "缺摘要", this.report.missingSummary.length);
    this.renderStat(stats, "补链建议", this.report.linkSuggestions.length);

    this.renderNotesSection(contentEl, "孤立笔记", this.report.isolatedNotes.slice(0, 20));
    this.renderNotesSection(contentEl, "缺少摘要", this.report.missingSummary.slice(0, 20));
    this.renderDuplicateSection(contentEl);
    this.renderLinkSuggestionSection(contentEl);
    this.renderTagSection(contentEl);
  }

  private renderStat(container: HTMLElement, label: string, value: number): void {
    const item = container.createDiv({ cls: "ai-second-brain-health-stat" });
    item.createDiv({ cls: "ai-second-brain-health-stat-value", text: String(value) });
    item.createDiv({ cls: "ai-second-brain-health-stat-label", text: label });
  }

  private renderNotesSection(container: HTMLElement, title: string, notes: KnowledgeNote[]): void {
    const section = container.createDiv({ cls: "ai-second-brain-health-section" });
    section.createEl("h3", { text: title });

    if (notes.length === 0) {
      section.createEl("p", { cls: "ai-second-brain-muted", text: "没有发现明显问题。" });
      return;
    }

    for (const note of notes) {
      this.renderNoteButton(section, note);
    }
  }

  private renderDuplicateSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "ai-second-brain-health-section" });
    section.createEl("h3", { text: "疑似重复" });

    if (this.report.duplicateGroups.length === 0) {
      section.createEl("p", { cls: "ai-second-brain-muted", text: "没有发现同名或高度相似标题。" });
      return;
    }

    for (const group of this.report.duplicateGroups.slice(0, 10)) {
      const groupEl = section.createDiv({ cls: "ai-second-brain-health-group" });
      groupEl.createDiv({ cls: "ai-second-brain-muted", text: group.reason });

      for (const note of group.notes) {
        this.renderNoteButton(groupEl, note);
      }
    }
  }

  private renderLinkSuggestionSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "ai-second-brain-health-section" });
    section.createEl("h3", { text: "补链建议" });

    if (this.report.linkSuggestions.length === 0) {
      section.createEl("p", { cls: "ai-second-brain-muted", text: "没有发现明显补链机会。" });
      return;
    }

    for (const suggestion of this.report.linkSuggestions.slice(0, 20)) {
      this.renderSuggestion(section, suggestion);
    }
  }

  private renderTagSection(container: HTMLElement): void {
    const section = container.createDiv({ cls: "ai-second-brain-health-section" });
    section.createEl("h3", { text: "高频标签" });

    if (this.report.tagStats.length === 0) {
      section.createEl("p", { cls: "ai-second-brain-muted", text: "当前范围没有标签。" });
      return;
    }

    const tags = section.createDiv({ cls: "ai-second-brain-health-tags" });

    for (const stat of this.report.tagStats.slice(0, 20)) {
      tags.createSpan({
        cls: "ai-second-brain-badge",
        text: `#${stat.tag} · ${stat.count}`
      });
    }
  }

  private renderNoteButton(container: HTMLElement, note: KnowledgeNote): void {
    const button = container.createEl("button", { cls: "ai-second-brain-health-note", attr: { type: "button" } });
    button.createSpan({ cls: "ai-second-brain-health-note-title", text: note.title });
    button.createSpan({ cls: "ai-second-brain-health-note-path", text: note.path });

    if (note.excerpt) {
      button.createSpan({ cls: "ai-second-brain-health-note-excerpt", text: note.excerpt });
    }

    button.addEventListener("click", () => {
      void this.openFile(note.path);
    });
  }

  private renderSuggestion(container: HTMLElement, suggestion: LinkSuggestion): void {
    const button = container.createEl("button", { cls: "ai-second-brain-health-note", attr: { type: "button" } });
    button.createSpan({
      cls: "ai-second-brain-health-note-title",
      text: `${suggestion.sourcePath} → ${suggestion.targetTitle}`
    });
    button.createSpan({ cls: "ai-second-brain-health-note-path", text: suggestion.reason });
    button.addEventListener("click", () => {
      void this.openFile(suggestion.sourcePath);
    });
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);

    if (!(file instanceof TFile)) {
      new Notice("找不到笔记文件。");
      return;
    }

    await this.app.workspace.getLeaf(false).openFile(file);
    this.close();
  }
}
