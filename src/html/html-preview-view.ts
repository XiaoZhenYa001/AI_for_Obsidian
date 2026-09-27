import { FileView, TFile, WorkspaceLeaf } from "obsidian";
import { buildHtmlPreviewDocument, HTML_PREVIEW_WRAPPER_SANDBOX, HTML_FULL_PREVIEW_SANDBOX, wrapFullHtmlPreview, wrapHtmlPreviewDocument } from "./html-document";
import type { HtmlPreviewServer, HtmlPreviewServerFactory } from "./html-preview-server";

export const HTML_PREVIEW_VIEW_TYPE = "ai-second-brain-html-preview";

export class HtmlPreviewView extends FileView {
  private frame?: HTMLIFrameElement;
  private sourceEl?: HTMLTextAreaElement;
  private statusEl?: HTMLElement;
  private refreshButton?: HTMLButtonElement;
  private previewButton?: HTMLButtonElement;
  private sourceButton?: HTMLButtonElement;
  private networkCheckbox?: HTMLInputElement;
  private mode: "full" | "isolated";
  private fullServer?: HtmlPreviewServer;
  private fullServerPath?: string;
  private dependencies = new Set<string>();
  private allowNetwork = false;
  private showingSource = false;
  private revision = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(leaf: WorkspaceLeaf, private readonly createFullPreview?: HtmlPreviewServerFactory) {
    super(leaf);
    this.mode = createFullPreview ? "full" : "isolated";
  }

  getViewType(): string { return HTML_PREVIEW_VIEW_TYPE; }
  getDisplayText(): string { return this.file?.name || "HTML 预览"; }
  getIcon(): string { return "app-window"; }
  canAcceptExtension(extension: string): boolean { return /^(?:html|htm)$/i.test(extension); }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("ai-second-brain-html-preview");
    const toolbar = this.contentEl.createDiv({ cls: "ai-second-brain-html-toolbar" });
    if (this.createFullPreview) {
      const mode = toolbar.createEl("select", { attr: { "aria-label": "HTML 预览方式" } });
      mode.createEl("option", { attr: { value: "full" }, text: "完整预览" });
      mode.createEl("option", { attr: { value: "isolated" }, text: "隔离预览" });
      mode.value = this.mode;
      mode.addEventListener("change", () => {
        this.mode = mode.value === "full" ? "full" : "isolated";
        this.cancelRefresh();
        this.clearPreview();
        void this.refresh();
      });
    }
    this.previewButton = toolbar.createEl("button", { text: "预览", attr: { type: "button" } });
    this.sourceButton = toolbar.createEl("button", { text: "源码", attr: { type: "button" } });
    this.refreshButton = toolbar.createEl("button", { text: "刷新", attr: { type: "button" } });
    this.previewButton.addEventListener("click", () => this.setSourceMode(false));
    this.sourceButton.addEventListener("click", () => this.setSourceMode(true));
    this.refreshButton.addEventListener("click", () => { void this.refresh(); });
    const networkLabel = toolbar.createEl("label", { cls: "ai-second-brain-html-network" });
    this.networkCheckbox = networkLabel.createEl("input", { type: "checkbox" });
    networkLabel.createSpan({ text: "允许在线资源" });
    this.networkCheckbox.addEventListener("change", () => {
      this.allowNetwork = Boolean(this.networkCheckbox?.checked);
      this.cancelRefresh();
      this.clearPreview();
      void this.refresh();
    });
    this.statusEl = this.contentEl.createDiv({ cls: "ai-second-brain-html-status", attr: { role: "status" } });
    const body = this.contentEl.createDiv({ cls: "ai-second-brain-html-body" });
    this.frame = body.createEl("iframe", {
      cls: "ai-second-brain-html-frame",
      attr: {
        title: "HTML 互动预览",
        sandbox: HTML_PREVIEW_WRAPPER_SANDBOX,
        referrerpolicy: "no-referrer",
        allow: "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      }
    });
    this.sourceEl = body.createEl("textarea", {
      cls: "ai-second-brain-html-source",
      attr: { "aria-label": "HTML 源码（只读）", readonly: "", spellcheck: "false" }
    });
    this.setSourceMode(false);
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path === this.file?.path || this.dependencies.has(file.path)) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.dependencies.has(file.path)) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file.path === this.file?.path || this.dependencies.has(oldPath)) this.scheduleRefresh();
    }));
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.cancelRefresh();
    this.file = file;
    this.allowNetwork = false;
    if (this.networkCheckbox) this.networkCheckbox.checked = false;
    this.clearPreview();
    const revision = this.revision;
    await this.stopFullPreview();
    if (revision !== this.revision) return;
    await this.refresh();
  }

  async onUnloadFile(): Promise<void> {
    this.cancelRefresh();
    this.dependencies.clear();
    this.clearPreview();
    await this.stopFullPreview();
    if (this.sourceEl) this.sourceEl.value = "";
  }

  async onClose(): Promise<void> {
    this.cancelRefresh();
    this.contentEl.empty();
    this.frame = undefined;
    this.sourceEl = undefined;
    await this.stopFullPreview();
  }

  private setSourceMode(showSource: boolean): void {
    this.showingSource = showSource;
    if (this.frame) this.frame.hidden = showSource;
    if (this.sourceEl) this.sourceEl.hidden = !showSource;
    this.previewButton?.toggleClass("is-active", !showSource);
    this.sourceButton?.toggleClass("is-active", showSource);
    this.previewButton?.setAttribute("aria-pressed", String(!showSource));
    this.sourceButton?.setAttribute("aria-pressed", String(showSource));
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 180);
  }

  private cancelRefresh(): void {
    this.revision += 1;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private clearPreview(): void {
    if (!this.frame) return;
    // Replacing the element destroys the old browsing context immediately;
    // assigning an empty srcdoc alone starts an asynchronous navigation.
    const replacement = this.frame.cloneNode(false) as HTMLIFrameElement;
    replacement.removeAttribute("srcdoc");
    replacement.removeAttribute("src");
    this.frame.replaceWith(replacement);
    this.frame = replacement;
  }

  private async stopFullPreview(): Promise<void> {
    const server = this.fullServer;
    this.fullServer = undefined;
    this.fullServerPath = undefined;
    await server?.close();
  }

  private async refresh(): Promise<void> {
    const file = this.file;
    if (!file || !this.frame || !this.sourceEl || !this.statusEl) return;
    const revision = ++this.revision;
    if (this.refreshButton) this.refreshButton.disabled = true;
    this.statusEl.setText("正在加载预览…");
    try {
      const source = await this.app.vault.read(file);
      if (revision !== this.revision || !this.frame || !this.sourceEl) return;
      if (this.mode === "full" && this.createFullPreview) {
        if (!this.fullServer || this.fullServerPath !== file.path) {
          await this.stopFullPreview();
          const dependencies = new Set<string>([file.path]);
          const server = await this.createFullPreview({
            filePath: file.path,
            allowNetwork: this.allowNetwork,
            readFile: async (path) => {
              const resource = this.app.vault.getAbstractFileByPath(path);
              return resource instanceof TFile ? { data: await this.app.vault.readBinary(resource) } : undefined;
            },
            onResource: (path) => dependencies.add(path)
          });
          if (revision !== this.revision || this.mode !== "full") { await server.close(); return; }
          this.fullServer = server;
          this.fullServerPath = file.path;
          this.dependencies = dependencies;
        }
        await this.fullServer.setAllowNetwork(this.allowNetwork);
        if (revision !== this.revision) return;
        this.sourceEl.value = source;
        this.frame.setAttribute("sandbox", HTML_FULL_PREVIEW_SANDBOX);
        this.frame.srcdoc = wrapFullHtmlPreview(this.fullServer.url);
        this.setSourceMode(this.showingSource);
        const folder = file.path.split("/").slice(0, -1).join("/") || "库根目录";
        this.statusEl.setText(`完整预览 · 原始 HTML · 资源目录：${folder} · ${this.allowNetwork ? "已允许在线资源" : "在线资源已阻止"}`);
        return;
      }
      await this.stopFullPreview();
      const result = await buildHtmlPreviewDocument(source, {
        filePath: file.path,
        allowNetwork: this.allowNetwork,
        readText: async (path) => {
          const resource = this.app.vault.getAbstractFileByPath(path);
          return resource instanceof TFile ? this.app.vault.read(resource) : undefined;
        },
        readBinary: async (path) => {
          const resource = this.app.vault.getAbstractFileByPath(path);
          return resource instanceof TFile ? this.app.vault.readBinary(resource) : undefined;
        }
      });
      if (revision !== this.revision || this.file?.path !== file.path) return;
      this.dependencies = new Set(result.dependencies);
      this.sourceEl.value = source;
      this.frame.setAttribute("sandbox", HTML_PREVIEW_WRAPPER_SANDBOX);
      this.frame.srcdoc = wrapHtmlPreviewDocument(result.srcdoc, this.allowNetwork);
      this.setSourceMode(this.showingSource);
      this.statusEl.setText(result.warnings.length > 0
        ? result.warnings.join(" · ")
        : this.allowNetwork ? "互动预览 · 已允许在线资源" : "互动预览 · 在线资源已阻止");
    } catch (error) {
      if (revision !== this.revision) return;
      this.clearPreview();
      this.statusEl.setText(`无法预览：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (revision === this.revision && this.refreshButton) this.refreshButton.disabled = false;
    }
  }
}
