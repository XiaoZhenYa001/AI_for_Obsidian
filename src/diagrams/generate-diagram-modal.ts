import { App, Editor, IconName, Modal, Notice, setIcon, Setting, TFile } from "obsidian";
import { EditorChangeTransaction } from "../actions/editor-change-transaction";
import type ObsidianAIPlugin from "../main";
import { isAbortError } from "../providers/errors";
import { Citation } from "../retrieval/types";
import { createIconButton } from "../ui/icon-button";
import { renderDiagramCanvas } from "./diagram-preview";
import { layoutDiagram } from "./layout";
import {
  DIAGRAM_TYPE_LABELS,
  DiagramDirection,
  DiagramDraft,
  DiagramNodeKind,
  DiagramSourceMode,
  DiagramSpec,
  DiagramType
} from "./types";

const SOURCE_LABELS: Record<DiagramSourceMode, string> = {
  selection: "选中文本",
  "current-file": "当前笔记",
  context: "授权范围"
};

type DiagramPreviewTab = "layout" | "nodes" | "edges" | "sources";

const DIAGRAM_NODE_KIND_LABELS: Record<DiagramNodeKind, string> = {
  primary: "核心",
  secondary: "主题",
  detail: "细节",
  decision: "判断"
};

export class GenerateDiagramModal extends Modal {
  private type: DiagramType = "mind-map";
  private direction: DiagramDirection = "LR";
  private sourceMode: DiagramSourceMode;
  private title = "";
  private focus = "";
  private embedInNote: boolean;
  private draft?: DiagramDraft;
  private previewEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private titleInputEl?: HTMLInputElement;
  private generateButtonEl?: HTMLButtonElement;
  private createButtonEl?: HTMLButtonElement;
  private insertionTarget?: EditorChangeTransaction;
  private generationController?: AbortController;
  private isCreating = false;
  private previewTab: DiagramPreviewTab = "layout";

  constructor(
    app: App,
    private readonly plugin: ObsidianAIPlugin,
    private readonly editor?: Editor,
    private readonly sourceFile?: TFile,
    private readonly providedText?: string,
    private readonly providedCitations: Citation[] = []
  ) {
    super(app);
    const selection = providedText?.trim() || editor?.getSelection().trim();
    this.sourceMode = selection ? "selection" : sourceFile ? "current-file" : "context";
    this.embedInNote = Boolean(editor && sourceFile && plugin.settings.diagramAutoEmbed);

    if (editor && sourceFile) {
      this.insertionTarget = EditorChangeTransaction.captureInsertion(editor, sourceFile.path);
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ai-second-brain-diagram-modal");
    this.modalEl.addClass("ai-second-brain-diagram-modal-shell");

    const scrollEl = contentEl.createDiv({ cls: "ai-second-brain-modal-scroll" });

    const header = scrollEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "workflow");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: "生成可编辑图谱" });
    heading.createEl("p", {
      cls: "ai-second-brain-muted",
      text: this.plugin.diagramService.isExcalidrawAvailable()
        ? "Excalidraw 已就绪"
        : "未检测到 Excalidraw，将创建 Mermaid 笔记"
    });

    const form = scrollEl.createDiv({ cls: "ai-second-brain-diagram-form" });
    this.renderSegmentedSetting(form, "图谱类型", DIAGRAM_TYPE_LABELS, this.type, (value) => {
      this.type = value;
      this.invalidateDraft();
    });

    const sourceOptions = this.getSourceOptions();
    this.renderSegmentedSetting(form, "资料来源", sourceOptions, this.sourceMode, (value) => {
      this.sourceMode = value;
      this.invalidateDraft();
    });

    this.renderSegmentedSetting(
      form,
      "布局方向",
      { LR: "横向", TB: "纵向" },
      this.direction,
      (value) => {
        this.direction = value;
        if (this.draft) {
          this.draft = { ...this.draft, layout: layoutDiagram(this.draft.spec, value) };
          this.statusEl?.setText("已调整 · 可创建");
          this.renderPreview();
        } else {
          this.invalidateDraft();
        }
      }
    );

    new Setting(form)
      .setName("标题")
      .addText((text) => {
        this.titleInputEl = text.inputEl;
        text.setPlaceholder("自动概括").setValue(this.title).onChange((value) => {
          this.title = value.trim();
          if (this.draft) {
            this.applyDraftSpec({ ...this.draft.spec, title: this.title || "AI 知识图谱" });
          } else {
            this.invalidateDraft();
          }
        });
      });

    new Setting(form)
      .setName("绘图重点")
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setPlaceholder("例如：突出因果关系、决策分支或核心概念");
        text.setValue(this.focus);
        text.onChange((value) => {
          this.focus = value.trim();
          this.invalidateDraft();
        });
      });

    if (this.insertionTarget) {
      new Setting(form)
        .setName("嵌入当前笔记")
        .addToggle((toggle) =>
          toggle.setValue(this.embedInNote).onChange((value) => {
            this.embedInNote = value;
          })
        );
    }

    const preview = scrollEl.createDiv({ cls: "ai-second-brain-diagram-preview-section" });
    const previewHeader = preview.createDiv({ cls: "ai-second-brain-generate-preview-header" });
    previewHeader.createDiv({ cls: "ai-second-brain-generate-preview-title", text: "结构预览" });
    this.statusEl = previewHeader.createDiv({ cls: "ai-second-brain-generate-preview-status", text: "等待生成" });
    this.previewEl = preview.createDiv({ cls: "ai-second-brain-diagram-preview" });
    this.renderPreview();

    const actions = contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    this.generateButtonEl = createIconButton(actions, "sparkles", "生成结构", "mod-cta");
    this.generateButtonEl.addEventListener("click", () => {
      if (this.generationController) {
        this.stopGeneration();
      } else {
        void this.generate();
      }
    });
    this.createButtonEl = createIconButton(
      actions,
      this.plugin.diagramService.isExcalidrawAvailable() ? "workflow" : "file-code-2",
      this.plugin.diagramService.isExcalidrawAvailable() ? "创建 Excalidraw" : "创建 Mermaid"
    );
    this.createButtonEl.disabled = !this.draft;
    this.createButtonEl.addEventListener("click", () => {
      void this.createDiagram();
    });
  }

  onClose(): void {
    this.generationController?.abort();
    this.generationController = undefined;
    this.isCreating = false;
    this.previewEl = undefined;
    this.statusEl = undefined;
    this.titleInputEl = undefined;
    this.generateButtonEl = undefined;
    this.createButtonEl = undefined;
    this.contentEl.empty();
  }

  private async generate(): Promise<void> {
    if (!this.generateButtonEl || this.generationController || this.isCreating) {
      return;
    }

    const controller = new AbortController();
    this.generationController = controller;
    this.setGenerationBusy(true);
    this.draft = undefined;
    this.renderPreview("正在提取节点和关系...");

    try {
      const draft = await this.plugin.diagramService.generateDraft({
        type: this.type,
        direction: this.direction,
        sourceMode: this.sourceMode,
        selection: this.providedText || this.editor?.getSelection(),
        sourceFilePath: this.sourceFile?.path,
        title: this.title,
        focus: this.focus,
        sourceCitations: this.providedText ? this.providedCitations : undefined,
        signal: controller.signal
      });

      if (this.generationController !== controller || controller.signal.aborted) {
        return;
      }

      this.draft = this.title
        ? { ...draft, spec: { ...draft.spec, title: this.title } }
        : draft;
      if (!this.title) {
        this.title = this.draft.spec.title;
        if (this.titleInputEl) {
          this.titleInputEl.value = this.title;
        }
      }
      this.previewTab = "layout";
      this.renderPreview();
      this.statusEl?.setText("可创建");
    } catch (error) {
      if (this.generationController !== controller) {
        return;
      }

      if (controller.signal.aborted || isAbortError(error)) {
        this.renderPreview("生成已停止，你可以调整设置后重新生成。");
        this.statusEl?.setText("已停止");
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.renderPreview(message, true);
      this.statusEl?.setText("需要处理");
      new Notice(message);
    } finally {
      if (this.generationController === controller) {
        this.generationController = undefined;
        this.setGenerationBusy(false);
      }
    }
  }

  private async createDiagram(): Promise<void> {
    if (!this.draft || !this.createButtonEl || this.isCreating || this.generationController) {
      return;
    }

    this.isCreating = true;
    this.setCreatingBusy(true);

    try {
      const result = await this.plugin.diagramService.createDiagram(this.draft);
      let embedded = false;

      if (this.embedInNote && this.insertionTarget) {
        const currentFile = this.plugin.getEditableMarkdownView()?.file;
        const applyResult = this.insertionTarget.apply(`\n\n![[${result.path}]]\n`, currentFile?.path);

        if (applyResult.applied) {
          embedded = true;
        } else {
          new Notice(`绘图已创建，但未嵌入笔记：${applyResult.reason}`);
        }
      }

      if (result.format === "mermaid") {
        const file = this.app.vault.getAbstractFileByPath(result.path);

        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
        }
      }

      new Notice(embedded ? "绘图已创建并嵌入当前笔记。" : "绘图已创建。");
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`创建绘图失败：${message}`);
      this.isCreating = false;
      this.setCreatingBusy(false);
      this.statusEl?.setText("创建失败");
    }
  }

  private renderPreview(message?: string, error = false): void {
    if (!this.previewEl) {
      return;
    }

    this.previewEl.empty();
    this.previewEl.toggleClass("is-error", error);

    if (message) {
      this.previewEl.createDiv({ cls: "ai-second-brain-diagram-empty", text: message });
      return;
    }

    if (!this.draft) {
      this.previewEl.createDiv({ cls: "ai-second-brain-diagram-empty", text: "生成后可检查节点、关系和引用来源。" });
      return;
    }

    const summary = this.previewEl.createDiv({ cls: "ai-second-brain-diagram-summary" });
    summary.createSpan({ cls: "ai-second-brain-diagram-summary-title", text: this.draft.spec.title });
    summary.createSpan({ text: `${this.draft.spec.nodes.length} 个节点` });
    summary.createSpan({ text: `${this.draft.spec.edges.length} 条关系` });
    summary.createSpan({ text: `${this.draft.sourcePaths.length} 个来源` });

    const tabs = this.previewEl.createDiv({ cls: "ai-second-brain-diagram-preview-tabs", attr: { role: "tablist" } });
    const tabOptions: Array<{ value: DiagramPreviewTab; label: string }> = [
      { value: "layout", label: "布局" },
      { value: "nodes", label: `节点 ${this.draft.spec.nodes.length}` },
      { value: "edges", label: `关系 ${this.draft.spec.edges.length}` },
      { value: "sources", label: `来源 ${this.draft.sourcePaths.length}` }
    ];

    for (const option of tabOptions) {
      const button = tabs.createEl("button", {
        cls: option.value === this.previewTab ? "is-active" : "",
        text: option.label,
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": option.value === this.previewTab ? "true" : "false"
        }
      });
      button.addEventListener("click", () => {
        this.previewTab = option.value;
        this.renderPreview();
      });
    }

    const body = this.previewEl.createDiv({ cls: "ai-second-brain-diagram-preview-body" });

    if (this.previewTab === "layout") {
      renderDiagramCanvas(body, this.draft.layout, this.draft.spec.title);
      return;
    }

    if (this.previewTab === "nodes") {
      this.renderNodePreview(body);
      return;
    }

    if (this.previewTab === "edges") {
      this.renderEdgePreview(body);
      return;
    }

    this.renderSourcePreview(body);
  }

  private renderNodePreview(container: HTMLElement): void {
    if (!this.draft) {
      return;
    }

    const toolbar = container.createDiv({ cls: "ai-second-brain-diagram-edit-toolbar" });
    const addButton = createIconButton(toolbar, "plus", "添加节点");
    addButton.disabled = this.draft.spec.nodes.length >= this.plugin.settings.diagramMaxNodes;
    addButton.addEventListener("click", () => this.addNode());

    const list = container.createDiv({ cls: "ai-second-brain-diagram-node-list" });
    for (const node of this.draft.spec.nodes) {
      const item = list.createDiv({ cls: "ai-second-brain-diagram-node" });
      item.createSpan({ cls: `ai-second-brain-diagram-node-kind is-${node.kind}` });
      const labelInput = item.createEl("input", {
        cls: "ai-second-brain-diagram-node-label-input",
        type: "text",
        value: node.label,
        attr: { maxlength: "100", "aria-label": `节点名称：${node.label}` }
      });
      labelInput.addEventListener("change", () => {
        const value = labelInput.value.trim();

        if (!value) {
          new Notice("节点名称不能为空。");
          this.renderPreview();
          return;
        }

        this.updateNode(node.id, { label: value });
      });
      labelInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          labelInput.blur();
        }
      });

      const kindSelect = item.createEl("select", {
        cls: "ai-second-brain-diagram-node-kind-select",
        attr: { "aria-label": `${node.label}的节点类型` }
      });
      for (const [kind, label] of Object.entries(DIAGRAM_NODE_KIND_LABELS) as Array<[DiagramNodeKind, string]>) {
        kindSelect.createEl("option", { value: kind, text: label });
      }
      kindSelect.value = node.kind;
      kindSelect.addEventListener("change", () => this.updateNode(node.id, { kind: kindSelect.value as DiagramNodeKind }));

      item.createSpan({
        cls: "ai-second-brain-diagram-node-source",
        text: node.sourcePath ? node.sourcePath.split("/").pop() || node.sourcePath : "",
        attr: { title: node.sourcePath || "" }
      });
      const deleteButton = createIconButton(item, "trash-2", "删除节点", "ai-second-brain-diagram-row-action");
      deleteButton.disabled = this.draft.spec.nodes.length <= 1;
      deleteButton.addEventListener("click", () => this.deleteNode(node.id));
    }
  }

  private renderEdgePreview(container: HTMLElement): void {
    if (!this.draft) {
      return;
    }

    const toolbar = container.createDiv({ cls: "ai-second-brain-diagram-edit-toolbar" });
    const addButton = createIconButton(toolbar, "plus", "添加关系");
    addButton.disabled = !this.canAddEdge();
    addButton.addEventListener("click", () => this.addEdge());

    if (this.draft.spec.edges.length === 0) {
      container.createDiv({ cls: "ai-second-brain-diagram-tab-empty", text: "当前结构没有可展示的关系。" });
      return;
    }

    const list = container.createDiv({ cls: "ai-second-brain-diagram-edge-list" });

    for (const [index, edge] of this.draft.spec.edges.entries()) {
      const item = list.createDiv({ cls: "ai-second-brain-diagram-edge" });
      const fromSelect = this.createNodeSelect(item, edge.from, `关系 ${index + 1} 的起点`);
      fromSelect.addEventListener("change", () => this.updateEdge(index, { from: fromSelect.value }));
      const arrow = item.createSpan({ cls: "ai-second-brain-diagram-edge-arrow" });
      setIcon(arrow, "arrow-right");
      const toSelect = this.createNodeSelect(item, edge.to, `关系 ${index + 1} 的终点`);
      toSelect.addEventListener("change", () => this.updateEdge(index, { to: toSelect.value }));
      const labelInput = item.createEl("input", {
        cls: "ai-second-brain-diagram-edge-label-input",
        type: "text",
        value: edge.label || "",
        placeholder: "关系说明",
        attr: { maxlength: "50", "aria-label": `关系 ${index + 1} 的说明` }
      });
      labelInput.addEventListener("change", () => this.updateEdge(index, { label: labelInput.value.trim() || undefined }));
      labelInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          labelInput.blur();
        }
      });
      const deleteButton = createIconButton(item, "trash-2", "删除关系", "ai-second-brain-diagram-row-action");
      deleteButton.addEventListener("click", () => this.deleteEdge(index));
    }
  }

  private createNodeSelect(container: HTMLElement, value: string, ariaLabel: string): HTMLSelectElement {
    const select = container.createEl("select", {
      cls: "ai-second-brain-diagram-edge-node-select",
      attr: { "aria-label": ariaLabel }
    });

    for (const node of this.draft?.spec.nodes || []) {
      select.createEl("option", { value: node.id, text: node.label });
    }

    select.value = value;
    return select;
  }

  private addNode(): void {
    if (!this.draft || this.draft.spec.nodes.length >= this.plugin.settings.diagramMaxNodes) {
      new Notice("已达到当前设置的最大节点数。");
      return;
    }

    const ids = new Set(this.draft.spec.nodes.map((node) => node.id));
    let index = this.draft.spec.nodes.length + 1;
    let id = `local-node-${index}`;

    while (ids.has(id)) {
      index += 1;
      id = `local-node-${index}`;
    }

    this.applyDraftSpec({
      ...this.draft.spec,
      nodes: [...this.draft.spec.nodes, { id, label: "新节点", kind: "detail" }]
    });
  }

  private updateNode(id: string, changes: Partial<{ label: string; kind: DiagramNodeKind }>): void {
    if (!this.draft) {
      return;
    }

    this.applyDraftSpec({
      ...this.draft.spec,
      nodes: this.draft.spec.nodes.map((node) => node.id === id ? { ...node, ...changes } : node)
    });
  }

  private deleteNode(id: string): void {
    if (!this.draft || this.draft.spec.nodes.length <= 1) {
      return;
    }

    let nodes = this.draft.spec.nodes.filter((node) => node.id !== id);
    if (!nodes.some((node) => node.kind === "primary")) {
      nodes = nodes.map((node, index) => index === 0 ? { ...node, kind: "primary" as DiagramNodeKind } : node);
    }

    this.applyDraftSpec({
      ...this.draft.spec,
      nodes,
      edges: this.draft.spec.edges.filter((edge) => edge.from !== id && edge.to !== id)
    });
  }

  private addEdge(): void {
    if (!this.draft) {
      return;
    }

    const existing = new Set(this.draft.spec.edges.map((edge) => `${edge.from}->${edge.to}`));
    for (const from of this.draft.spec.nodes) {
      for (const to of this.draft.spec.nodes) {
        if (from.id !== to.id && !existing.has(`${from.id}->${to.id}`)) {
          this.applyDraftSpec({
            ...this.draft.spec,
            edges: [...this.draft.spec.edges, { from: from.id, to: to.id }]
          });
          return;
        }
      }
    }

    new Notice("当前节点之间已经没有可添加的唯一关系。");
  }

  private updateEdge(index: number, changes: Partial<{ from: string; to: string; label?: string }>): void {
    if (!this.draft) {
      return;
    }

    const edge = this.draft.spec.edges[index];
    const next = { ...edge, ...changes };
    const duplicate = this.draft.spec.edges.some(
      (candidate, candidateIndex) => candidateIndex !== index && candidate.from === next.from && candidate.to === next.to
    );

    if (next.from === next.to || duplicate) {
      new Notice(next.from === next.to ? "关系的起点和终点不能相同。" : "该节点关系已经存在。");
      this.renderPreview();
      return;
    }

    this.applyDraftSpec({
      ...this.draft.spec,
      edges: this.draft.spec.edges.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate)
    });
  }

  private deleteEdge(index: number): void {
    if (!this.draft) {
      return;
    }

    this.applyDraftSpec({
      ...this.draft.spec,
      edges: this.draft.spec.edges.filter((_, candidateIndex) => candidateIndex !== index)
    });
  }

  private canAddEdge(): boolean {
    if (!this.draft || this.draft.spec.nodes.length < 2) {
      return false;
    }

    const possibleEdges = this.draft.spec.nodes.length * (this.draft.spec.nodes.length - 1);
    return this.draft.spec.edges.length < Math.min(possibleEdges, this.plugin.settings.diagramMaxNodes * 3);
  }

  private applyDraftSpec(spec: DiagramSpec): void {
    if (!this.draft) {
      return;
    }

    this.draft = {
      ...this.draft,
      spec,
      layout: layoutDiagram(spec, this.direction)
    };
    this.statusEl?.setText("已调整 · 可创建");
    this.setGenerationBusy(false);
    this.renderPreview();
  }

  private renderSourcePreview(container: HTMLElement): void {
    if (!this.draft) {
      return;
    }

    if (this.draft.sourcePaths.length === 0) {
      container.createDiv({ cls: "ai-second-brain-diagram-tab-empty", text: "当前图谱没有可跳转的来源笔记。" });
      return;
    }

    const list = container.createDiv({ cls: "ai-second-brain-diagram-source-list" });

    for (const path of this.draft.sourcePaths) {
      const button = list.createEl("button", {
        cls: "ai-second-brain-diagram-source",
        attr: { type: "button", title: path, "aria-label": `打开来源 ${path}` }
      });
      const icon = button.createSpan({ cls: "ai-second-brain-diagram-source-icon" });
      setIcon(icon, "file-text");
      const copy = button.createSpan({ cls: "ai-second-brain-diagram-source-copy" });
      copy.createSpan({ cls: "ai-second-brain-diagram-source-name", text: path.split("/").pop() || path });
      copy.createSpan({ cls: "ai-second-brain-diagram-source-path", text: path });
      const open = button.createSpan({ cls: "ai-second-brain-diagram-source-open" });
      setIcon(open, "arrow-up-right");
      button.addEventListener("click", () => {
        void this.openSource(path);
      });
    }
  }

  private async openSource(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);

    if (!(file instanceof TFile)) {
      new Notice("来源文件已不存在。");
      return;
    }

    try {
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`无法打开来源文件：${message}`);
    }
  }

  private renderSegmentedSetting<T extends string>(
    container: HTMLElement,
    label: string,
    options: Record<T, string>,
    value: T,
    onChange: (value: T) => void
  ): void {
    const row = container.createDiv({ cls: "ai-second-brain-diagram-setting" });
    row.createDiv({ cls: "ai-second-brain-diagram-setting-label", text: label });
    const control = row.createDiv({ cls: "ai-second-brain-segmented" });

    for (const [optionValue, optionLabel] of Object.entries(options) as Array<[T, string]>) {
      const button = control.createEl("button", {
        cls: optionValue === value ? "is-active" : "",
        text: optionLabel,
        attr: { type: "button" }
      });
      button.addEventListener("click", () => {
        for (const sibling of Array.from(control.children)) {
          sibling.removeClass("is-active");
        }
        button.addClass("is-active");
        onChange(optionValue);
      });
    }
  }

  private getSourceOptions(): Record<DiagramSourceMode, string> {
    const options = {} as Record<DiagramSourceMode, string>;

    if (this.providedText?.trim() || this.editor?.getSelection().trim()) {
      options.selection = this.providedText ? "当前 AI 回复" : SOURCE_LABELS.selection;
    }

    if (this.sourceFile) {
      options["current-file"] = this.sourceFile.name;
    }

    options.context = SOURCE_LABELS.context;
    return options;
  }

  private setGenerationBusy(value: boolean): void {
    if (this.generateButtonEl) {
      this.generateButtonEl.disabled = false;
      this.generateButtonEl.toggleClass("mod-cta", !value && !this.draft);
      this.setButtonIcon(this.generateButtonEl, value ? "square" : "sparkles");
      this.setButtonLabel(this.generateButtonEl, value ? "停止生成" : this.draft ? "重新生成" : "生成结构");
    }

    if (this.createButtonEl) {
      this.createButtonEl.disabled = value || !this.draft;
      this.createButtonEl.toggleClass("mod-cta", !value && Boolean(this.draft));
    }

    if (value) {
      this.statusEl?.setText("生成中");
    }
  }

  private setCreatingBusy(value: boolean): void {
    if (this.generateButtonEl) {
      this.generateButtonEl.disabled = value;
    }

    if (this.createButtonEl) {
      this.createButtonEl.disabled = value || !this.draft;
      this.createButtonEl.toggleClass("mod-cta", Boolean(this.draft));
      this.setButtonLabel(
        this.createButtonEl,
        value
          ? "创建中..."
          : this.plugin.diagramService.isExcalidrawAvailable()
            ? "创建 Excalidraw"
            : "创建 Mermaid"
      );
    }

    if (value) {
      this.statusEl?.setText("正在创建");
    }
  }

  private stopGeneration(): void {
    if (!this.generationController) {
      return;
    }

    this.generationController.abort();

    if (this.generateButtonEl) {
      this.generateButtonEl.disabled = true;
      this.setButtonLabel(this.generateButtonEl, "正在停止...");
    }
  }

  private invalidateDraft(): void {
    if (this.generationController) {
      this.generationController.abort();
      this.generationController = undefined;
    }

    this.draft = undefined;
    this.previewTab = "layout";
    this.setGenerationBusy(false);

    if (this.createButtonEl) {
      this.createButtonEl.disabled = true;
    }

    this.statusEl?.setText("等待生成");
    this.renderPreview();
  }

  private setButtonLabel(button: HTMLButtonElement, text: string): void {
    button.querySelector<HTMLElement>(".ai-second-brain-button-label")?.setText(text);
  }

  private setButtonIcon(button: HTMLButtonElement, icon: IconName): void {
    const iconEl = button.querySelector<HTMLElement>(".ai-second-brain-button-icon");

    if (iconEl) {
      setIcon(iconEl, icon);
    }
  }
}
