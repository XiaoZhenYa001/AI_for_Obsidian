import { FileSystemAdapter, FileView, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { HtmlSourceSession } from "./html-source-session";
import { HtmlDraftStore } from "./html-draft-store";
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
  private draftTimer?: ReturnType<typeof setTimeout>;
  private editor = new HtmlSourceSession();
  private editorPath?: string;
  private saveButton?: HTMLButtonElement;
  private discardButton?: HTMLButtonElement;
  private copyButton?: HTMLButtonElement;
  private editorStatus?: HTMLElement;
  private saving = false;
  private paused = false;
  private visible = true;
  private pauseWhenHidden = true;
  private closed = false;
  private refreshPending = false;
  private readonly drafts: HtmlDraftStore;
  private recovery?: { editor: HtmlSourceSession; text: string; task: Promise<void> };

  constructor(leaf: WorkspaceLeaf, private readonly createFullPreview?: HtmlPreviewServerFactory, private readonly isEnabled: () => boolean = () => true) {
    super(leaf);
    this.mode = createFullPreview ? "full" : "isolated";
    // Obsidian 1.8.7 added vault-scoped local storage. Keep the declared 1.5 baseline working too.
    const storageKey = (key: string): string => {
      const adapter = this.app.vault.adapter;
      const vaultId = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : this.app.vault.getName();
      return `${vaultId}:${key}`;
    };
    this.drafts = new HtmlDraftStore(
      key => typeof this.app.loadLocalStorage === "function" ? this.app.loadLocalStorage(key) : JSON.parse(localStorage.getItem(storageKey(key)) || "null"),
      (key, value) => {
        if (typeof this.app.saveLocalStorage === "function") this.app.saveLocalStorage(key, value);
        else if (value === null) localStorage.removeItem(storageKey(key));
        else localStorage.setItem(storageKey(key), JSON.stringify(value));
      }
    );
  }

  getViewType(): string { return HTML_PREVIEW_VIEW_TYPE; }
  getDisplayText(): string { return this.file?.name || "HTML 预览"; }
  getIcon(): string { return "app-window"; }
  canAcceptExtension(extension: string): boolean { return /^(?:html|htm)$/i.test(extension); }

  async onOpen(): Promise<void> {
    this.closed = false;
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
    this.saveButton = toolbar.createEl("button", { text: "保存", attr: { type: "button", title: "保存源码（Ctrl/Cmd+S）" } });
    this.saveButton.addEventListener("click", () => { void this.saveSource(); });
    this.discardButton = toolbar.createEl("button", { text: "放弃修改", attr: { type: "button" } });
    this.discardButton.addEventListener("click", () => this.confirmDiscard());
    this.copyButton = toolbar.createEl("button", { text: "另存副本", attr: { type: "button" } });
    this.copyButton.addEventListener("click", () => { void this.saveCopy(); });
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
    const powerLabel = toolbar.createEl("label", { cls: "ai-second-brain-html-network", attr: { title: "切到源码或隐藏页面时暂停脚本；返回预览会重新加载，页面运行状态会重置。需要持续计时或播放时可关闭。" } });
    const power = powerLabel.createEl("input", { type: "checkbox" });
    power.checked = true;
    powerLabel.createSpan({ text: "隐藏时暂停" });
    power.addEventListener("change", () => { this.pauseWhenHidden = power.checked; this.updatePause(); });
    this.editorStatus = this.contentEl.createDiv({ cls: "ai-second-brain-html-status", attr: { role: "status" } });
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
      attr: { "aria-label": "HTML 源码", spellcheck: "false", autocapitalize: "off", autocomplete: "off", wrap: "off" }
    });
    this.sourceEl.readOnly = true;
    this.sourceEl.addEventListener("input", () => {
      this.editor.text = this.sourceEl!.value;
      this.updateEditor();
      if (this.draftTimer !== undefined) clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => this.persistDraft(), 600);
    });
    this.sourceEl.addEventListener("blur", () => this.persistDraft());
    this.sourceEl.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopPropagation(); void this.saveSource();
      }
    });
    this.registerDomEvent(this.contentEl.ownerDocument, "visibilitychange", () => this.updatePause());
    const observer = new IntersectionObserver(entries => {
      this.visible = entries.some(entry => entry.isIntersecting);
      this.updatePause();
    });
    observer.observe(this.contentEl);
    this.register(() => observer.disconnect());
    this.setSourceMode(false);
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path === this.file?.path || this.dependencies.has(file.path)) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (this.dependencies.has(file.path)) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (oldPath === this.editorPath) {
        try { this.drafts.rename(oldPath, file.path, this.editor.base, this.editor.text); }
        catch { new Notice("移动文件后无法更新草稿，请保存源码。"); }
        this.editorPath = file.path;
        this.persistDraft();
      }
      if (file.path === this.file?.path || this.dependencies.has(oldPath)) this.scheduleRefresh();
    }));
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.cancelRefresh();
    const loadRevision = this.revision;
    await this.preserveDraftBeforeLeave();
    if (loadRevision !== this.revision || this.closed) return;
    this.editor = new HtmlSourceSession();
    this.editorPath = undefined;
    if (this.sourceEl) { this.sourceEl.value = ""; this.sourceEl.readOnly = true; }
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
    const preservation = this.preserveDraftBeforeLeave();
    this.editorPath = undefined;
    this.cancelRefresh();
    this.file = null;
    this.dependencies.clear();
    this.clearPreview();
    if (this.sourceEl) this.sourceEl.value = "";
    await Promise.all([this.stopFullPreview(), preservation]);
  }

  async onClose(): Promise<void> {
    const preservation = this.preserveDraftBeforeLeave();
    this.closed = true;
    this.cancelRefresh();
    this.contentEl.empty();
    this.frame = undefined;
    this.sourceEl = undefined;
    await Promise.all([this.stopFullPreview(), preservation]);
  }

  private setSourceMode(showSource: boolean): void {
    this.showingSource = showSource;
    if (this.frame) this.frame.hidden = showSource;
    if (this.sourceEl) this.sourceEl.hidden = !showSource;
    this.previewButton?.toggleClass("is-active", !showSource);
    this.sourceButton?.toggleClass("is-active", showSource);
    this.previewButton?.setAttribute("aria-pressed", String(!showSource));
    this.sourceButton?.setAttribute("aria-pressed", String(showSource));
    this.updateEditor();
    this.updatePause();
    if (showSource && !this.editorPath && this.file) void this.refresh();
  }

  private updatePause(): void {
    const paused = this.pauseWhenHidden && (this.showingSource || !this.visible || this.contentEl.ownerDocument.hidden);
    if (this.closed) return;
    if (paused === this.paused) {
      if (this.refreshPending && this.showingSource && this.visible && !this.contentEl.ownerDocument.hidden) void this.refresh();
      return;
    }
    this.paused = paused;
    if (paused) {
      this.cancelRefresh();
      this.clearPreview();
      if (this.refreshButton) this.refreshButton.disabled = false;
      this.statusEl?.setText("预览已暂停以节能，返回可见预览时重新加载。未保存的源码不会执行。");
      if (this.refreshPending && this.showingSource && this.visible && !this.contentEl.ownerDocument.hidden) void this.refresh();
    } else if (this.file) void this.refresh();
  }

  private persistDraft(): boolean {
    if (this.draftTimer !== undefined) clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    if (!this.editorPath) return true;
    try {
      this.drafts.persist(this.editorPath, this.editor.base, this.editor.text);
      return true;
    } catch {
      new Notice("无法保留 HTML 草稿，请保存或复制源码后再关闭页面。");
      return false;
    }
  }

  private preserveDraftBeforeLeave(): Promise<void> {
    if (this.persistDraft() || !this.editor.dirty || !this.editorPath) return Promise.resolve();
    const editor = this.editor;
    const text = editor.text;
    if (this.recovery?.editor === editor && this.recovery.text === text) return this.recovery.task;
    const path = this.editorPath.replace(/\.html?$/i, `-recovery-${crypto.randomUUID().slice(0, 8)}.html`);
    const task = (async () => {
      try {
        await this.app.vault.create(path, text);
        new Notice(`本机草稿存储不可用，已另存恢复副本：${path}`);
      } catch {
        // Keep a copyable surface alive even after FileView has been detached.
        const modal = new Modal(this.app);
        modal.contentEl.createEl("p", { text: "草稿存储和恢复副本均保存失败。请复制下面的源码，确认保留后再关闭此窗口。" });
        const copy = modal.contentEl.createEl("textarea", { attr: { "aria-label": "待恢复的 HTML 源码", readonly: "" } });
        copy.value = text;
        copy.style.cssText = "width:100%;height:50vh;font-family:monospace";
        modal.contentEl.createEl("button", { text: "全选源码" }).onclick = () => { copy.focus(); copy.select(); };
        modal.open();
      }
    })();
    this.recovery = { editor, text, task };
    return task;
  }

  private updateEditor(): void {
    if (this.saveButton) { this.saveButton.hidden = !this.showingSource; this.saveButton.disabled = !this.editorPath || !this.editor.dirty || this.saving; }
    if (this.discardButton) { this.discardButton.hidden = !this.showingSource; this.discardButton.disabled = !this.editor.dirty || this.saving; }
    if (this.copyButton) { this.copyButton.hidden = !this.showingSource || !this.editor.conflict; this.copyButton.disabled = this.saving; }
    this.editorStatus?.setText(this.editor.conflict ? "文件已在外部修改，当前草稿已保留。保存不会覆盖外部修改；可另存副本。"
      : this.editor.dirty ? "源码有未保存修改 · Ctrl/Cmd+S 保存 · 草稿会在本机恢复，预览显示已保存的文件"
      : this.showingSource ? "可直接编辑 HTML · Ctrl/Cmd+S 保存到原文件" : "");
    if (this.editorStatus) this.editorStatus.hidden = !this.showingSource && !this.editor.dirty;
  }

  private async saveSource(): Promise<void> {
    const file = this.file;
    const editor = this.editor;
    if (!file || !this.editorPath || !editor.dirty || this.saving) return;
    this.saving = true; this.updateEditor();
    try {
      await editor.save(update => this.app.vault.process(file, update));
      if (editor !== this.editor || this.closed || !this.editorPath) {
        // A close during save already stored the draft; update its baseline without touching the new editor.
        try { this.drafts.persist(file.path, editor.base, editor.text); }
        catch { /* The earlier recovery draft or fallback copy is still available. */ }
        return;
      }
      this.persistDraft();
      this.scheduleRefresh();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.saving = false;
      if (!this.closed) this.updateEditor();
    }
  }

  private confirmDiscard(): void {
    if (!this.editor.dirty || this.saving) return;
    const editor = this.editor;
    const modal = new Modal(this.app);
    modal.contentEl.createEl("p", { text: "放弃当前未保存的源码，重新载入磁盘文件？" });
    modal.contentEl.createEl("button", { text: "取消" }).onclick = () => modal.close();
    modal.contentEl.createEl("button", { text: "放弃并重新载入" }).onclick = async () => {
      modal.close();
      if (editor !== this.editor || !this.file || this.closed) return;
      try {
        const draft = editor.text;
        const source = await this.app.vault.read(this.file);
        if (editor !== this.editor || this.closed) return;
        if (editor.text !== draft) { new Notice("读取期间源码又有修改，已保留，请重新确认放弃。"); return; }
        editor.load(source); this.sourceEl!.value = source;
        this.persistDraft(); this.updateEditor(); this.scheduleRefresh();
      } catch (error) { new Notice(`无法重新载入：${String(error)}`); }
    };
    modal.open();
  }

  private async saveCopy(): Promise<void> {
    if (!this.file || this.saving) return;
    const path = this.file.path.replace(/\.html?$/i, `-draft-${Date.now()}.html`);
    const text = this.editor.text;
    this.saving = true; this.updateEditor();
    try { await this.app.vault.create(path, text); new Notice(`源码副本已保存：${path}`); }
    catch (error) { new Notice(`无法保存副本：${String(error)}`); }
    finally { this.saving = false; if (!this.closed) this.updateEditor(); }
  }

  private scheduleRefresh(): void {
    this.refreshPending = true;
    if (this.closed || (this.paused && (!this.showingSource || !this.visible || this.contentEl.ownerDocument.hidden))) return;
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
    if (this.closed || !file || !this.frame || !this.sourceEl || !this.statusEl) return;
    if (!this.isEnabled()) {
      this.cancelRefresh();
      this.clearPreview();
      await this.stopFullPreview();
      this.statusEl.setText("HTML 原生预览已关闭，可在插件设置中开启。更改默认打开方式需要重新加载插件。");
      return;
    }
    const revision = ++this.revision;
    this.refreshPending = false;
    if (this.refreshButton) this.refreshButton.disabled = true;
    this.statusEl.setText("正在加载预览…");
    try {
      const source = await this.app.vault.read(file);
      if (revision !== this.revision || !this.frame || !this.sourceEl) return;
      if (this.editorPath !== file.path) {
        let draft: { base: string; text: string } | undefined;
        try {
          draft = this.drafts.restore(file.path);
        } catch { /* A corrupt local draft does not prevent opening the actual file. */ }
        this.editor.load(source, draft);
        this.editorPath = file.path;
      } else this.editor.receive(source);
      if (this.sourceEl.value !== this.editor.text) this.sourceEl.value = this.editor.text;
      this.sourceEl.readOnly = false;
      this.updateEditor();
      if (this.paused) {
        this.statusEl.setText("预览已暂停以节能，返回可见预览时重新加载。未保存的源码不会执行。");
        return;
      }
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
