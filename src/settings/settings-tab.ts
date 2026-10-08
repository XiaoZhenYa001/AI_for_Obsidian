import { App, FuzzySuggestModal, IconName, PluginSettingTab, setIcon, Setting, TFile, TFolder } from "obsidian";
import { ContextScope, ContextScopeMode, scopeModeLabel } from "../context/scope-types";
import type ObsidianAIPlugin from "../main";
import { AIProviderConfig, AIProviderType } from "../providers/types";
import { BUILT_IN_PROMPT_TEMPLATES } from "../templates/built-in-templates";
import { PromptTemplate, PromptTemplateOutputMode, PromptTemplateTask } from "../templates/types";
import { configureProvider } from "./provider-config-modal";
import { isContextFile } from "../utils/context-files";

const TEMPLATE_TASK_DISPLAY: Record<PromptTemplateTask, string> = {
  "selection-explain": "解释选中文本",
  "selection-summarize": "总结选中文本",
  "selection-rewrite": "改写选中文本",
  "selection-translate": "翻译选中文本",
  "selection-expand": "扩写选中文本",
  "selection-condense": "缩写选中文本",
};

type ListSettingPicker = "markdown-file" | "folder";

type ListSettingOptions = {
  placeholder?: string;
  picker?: ListSettingPicker;
  normalize?: (value: string) => string;
  displayValue?: (value: string) => string;
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSave(fn: () => Promise<void>, delay = 500): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    fn();
  }, delay);
}

export class ObsidianAISettingTab extends PluginSettingTab {
  private readonly expandedCards = new Set<string>();
  private readonly initializedCards = new Set<string>();
  private activeSubview?: "guide";
  private settingsHostEls: HTMLElement[] = [];

  constructor(app: App, private readonly plugin: ObsidianAIPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ai-second-brain-settings");
    this.clearSettingsHostClasses();
    let host = containerEl.parentElement;
    for (let depth = 0; host && depth < 2; depth += 1) {
      host.addClass("ai-second-brain-settings-host");
      this.settingsHostEls.push(host);
      host = host.parentElement;
    }

    if (this.activeSubview === "guide") {
      this.renderGuideSubview(containerEl);
      return;
    }

    this.renderSettingsHero(containerEl);
    this.renderSettingsNavigation(containerEl);
    this.renderControlCenter(containerEl);
    this.renderSettingsSection(containerEl, "providers", "server", "AI 服务商", "管理模型提供方、默认模型和任务分工。", (section) => {
      this.renderProviderSection(section);
    });
    this.renderSettingsSection(containerEl, "contexts", "folder-lock", "上下文范围", "精确控制 AI 可以读取哪些笔记、Canvas 和 Excalidraw 文件。", (section) => {
      this.renderContextSection(section);
    });
    this.renderSettingsSection(containerEl, "templates", "scroll-text", "Prompt 模板", "维护选区工具条与命令面板使用的任务提示词。", (section) => {
      this.renderTemplateSection(section);
    });
    this.renderSettingsSection(containerEl, "diagrams", "workflow", "视觉图谱", "配置 Excalidraw 图谱的保存位置和生成边界。", (section) => {
      this.renderDiagramSection(section);
    });
    this.renderSettingsSection(containerEl, "html", "app-window", "HTML 预览", "选择是否使用本插件在 Obsidian 内查看 HTML 页面。", (section) => {
      new Setting(section).setName("启用 HTML 原生预览")
        .setDesc("默认关闭。开启后可完整预览 HTML；更改后重新加载插件，以更新 .html / .htm 的默认打开方式。关闭会立即关闭本插件的预览页。")
        .addToggle(toggle => toggle.setValue(this.plugin.settings.enableHtmlPreview).onChange(async value => {
          await this.plugin.setHtmlPreviewEnabled(value);
        }));
    });
  }

  hide(): void {
    this.activeSubview = undefined;
    this.clearSettingsHostClasses();
  }

  private clearSettingsHostClasses(): void {
    for (const host of this.settingsHostEls) host.removeClass("ai-second-brain-settings-host");
    this.settingsHostEls = [];
  }

  private renderSettingsHero(containerEl: HTMLElement): void {
    const hero = containerEl.createDiv({ cls: "ai-second-brain-settings-hero" });
    const icon = hero.createDiv({ cls: "ai-second-brain-settings-hero-icon" });
    setIcon(icon, "brain-circuit");
    const copy = hero.createDiv({ cls: "ai-second-brain-settings-hero-copy" });
    copy.createEl("h2", { text: "AI Second Brain" });
    copy.createEl("p", {
      text: "配置 AI 服务商、默认模型和上下文访问范围。插件只会读取当前授权范围内的笔记。"
    });
  }

  private renderSettingsNavigation(containerEl: HTMLElement): void {
    const navigation = containerEl.createEl("nav", {
      cls: "ai-second-brain-settings-navigation",
      attr: { "aria-label": "设置分类" }
    });
    const items: Array<{ target?: string; icon: IconName; label: string; subview?: "guide" }> = [
      { target: "ai-second-brain-settings-overview", icon: "layout-dashboard", label: "概览" },
      { target: "ai-second-brain-settings-providers", icon: "server", label: "服务商" },
      { target: "ai-second-brain-settings-contexts", icon: "folder-lock", label: "上下文" },
      { target: "ai-second-brain-settings-templates", icon: "scroll-text", label: "模板" },
      { target: "ai-second-brain-settings-diagrams", icon: "workflow", label: "图谱" },
      { target: "ai-second-brain-settings-html", icon: "app-window", label: "HTML" },
      { icon: "book-open", label: "指南", subview: "guide" }
    ];

    for (const item of items) {
      const button = this.createIconButton(navigation, item.icon, item.label, "ai-second-brain-settings-navigation-item");
      button.addEventListener("click", () => {
        if (item.subview) {
          this.activeSubview = item.subview;
          this.display();
          this.containerEl.scrollTop = 0;
          return;
        }
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!item.target) return;
        this.containerEl.querySelector<HTMLElement>(`#${item.target}`)?.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "start"
        });
      });
    }
  }

  private renderSettingsSection(
    containerEl: HTMLElement,
    sectionId: string,
    iconName: IconName,
    title: string,
    description: string,
    renderBody: (section: HTMLElement) => void
  ): void {
    const section = containerEl.createDiv({
      cls: "ai-second-brain-settings-section",
      attr: { id: `ai-second-brain-settings-${sectionId}` }
    });
    const header = section.createDiv({ cls: "ai-second-brain-settings-section-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-settings-section-icon" });
    setIcon(icon, iconName);
    const copy = header.createDiv({ cls: "ai-second-brain-settings-section-copy" });
    copy.createEl("h3", { text: title });
    copy.createEl("p", { text: description });
    renderBody(section.createDiv({ cls: "ai-second-brain-settings-section-body" }));
  }

  private renderControlCenter(containerEl: HTMLElement): void {
    const activeScope = this.plugin.getActiveContextScope();
    const activeFiles = this.plugin.contextScopeResolver.resolve(activeScope);
    const enabledProviders = this.plugin.settings.providers.filter((provider) => provider.enabled);
    const defaultChatProvider = this.findProvider(this.plugin.settings.defaultChatProviderId);
    const defaultEditProvider = this.findProvider(this.plugin.settings.defaultEditProviderId);
    const card = containerEl.createDiv({
      cls: "ai-second-brain-control-center",
      attr: { id: "ai-second-brain-settings-overview" }
    });
    const header = card.createDiv({ cls: "ai-second-brain-control-header" });
    const title = header.createDiv({ cls: "ai-second-brain-control-title" });
    title.createEl("h3", { text: "上下文控制中心" });
    title.createEl("p", {
      text: "确认 AI 当前能读取的内容、模型入口与隐私边界。"
    });
    header.createSpan({
      cls: activeScope?.allowCloudModels ? "ai-second-brain-badge" : "ai-second-brain-badge ai-second-brain-badge-warning",
      text: activeScope?.allowCloudModels ? "允许云端模型" : "仅建议本地模型"
    });

    const stats = card.createDiv({ cls: "ai-second-brain-control-stats" });
    this.renderControlStat(stats, "激活范围", activeScope?.name || "未选择", activeScope ? scopeModeLabel(activeScope.mode) : "无可用范围");
    this.renderControlStat(stats, "授权文件", `${activeFiles.length}`, activeFiles.length > 0 ? "个上下文文件" : "当前范围为空");
    this.renderControlStat(stats, "聊天模型", this.providerSummary(defaultChatProvider), defaultChatProvider?.enabled ? "可用" : "未启用或未设置");
    this.renderControlStat(stats, "编辑模型", this.providerSummary(defaultEditProvider), defaultEditProvider?.enabled ? "可用" : "未启用或未设置");
    this.renderControlStat(stats, "服务商", `${enabledProviders.length}/${this.plugin.settings.providers.length}`, "已启用 / 已配置");
    this.renderControlStat(stats, "云端权限", activeScope?.allowCloudModels ? "开启" : "关闭", activeScope?.allowCloudModels ? "允许发送授权内容" : "请优先使用本地模型");

    const switcher = card.createDiv({ cls: "ai-second-brain-control-switcher" });
    new Setting(switcher)
      .setName("快速切换上下文")
      .setDesc("切换后，侧边栏问答、生成和编辑任务都会使用新的授权范围。")
      .addDropdown((dropdown) => {
        for (const scope of this.plugin.settings.contextScopes) {
          const count = this.plugin.countFilesInContextScope(scope);
          dropdown.addOption(scope.id, `${scope.name} (${count})`);
        }

        dropdown.setValue(this.plugin.settings.activeContextScopeId);
        dropdown.onChange(async (value) => {
          await this.plugin.setActiveContextScope(value);
          this.display();
        });
      });

    this.renderAuthorizedFilePreview(card, activeFiles);
  }

  private renderControlStat(containerEl: HTMLElement, label: string, value: string, detail: string): void {
    const stat = containerEl.createDiv({ cls: "ai-second-brain-control-stat" });
    stat.createDiv({ cls: "ai-second-brain-control-stat-label", text: label });
    stat.createDiv({ cls: "ai-second-brain-control-stat-value", text: value });
    stat.createDiv({ cls: "ai-second-brain-control-stat-detail", text: detail });
  }

  private renderAuthorizedFilePreview(containerEl: HTMLElement, files: { path: string; basename: string }[]): void {
    const preview = containerEl.createDiv({ cls: "ai-second-brain-authorized-preview" });
    const header = preview.createDiv({ cls: "ai-second-brain-authorized-header" });
    header.createDiv({ cls: "ai-second-brain-authorized-title", text: "当前可访问文件" });
    header.createDiv({ cls: "ai-second-brain-authorized-count", text: files.length > 0 ? `显示 ${Math.min(files.length, 6)} / ${files.length}` : "无文件" });

    if (files.length === 0) {
      preview.createDiv({
        cls: "ai-second-brain-authorized-empty",
        text: "当前范围没有命中任何可读取文件。AI 不会读取笔记内容。"
      });
      return;
    }

    const list = preview.createDiv({ cls: "ai-second-brain-authorized-list" });

    for (const file of files.slice(0, 6)) {
      const item = list.createDiv({ cls: "ai-second-brain-authorized-file" });
      item.createDiv({ cls: "ai-second-brain-authorized-file-name", text: file.basename });
      item.createDiv({ cls: "ai-second-brain-authorized-file-path", text: file.path });
    }
  }

  private findProvider(providerId: string): AIProviderConfig | undefined {
    return this.plugin.settings.providers.find((provider) => provider.id === providerId);
  }

  private providerSummary(provider: AIProviderConfig | undefined): string {
    if (!provider) {
      return "未设置";
    }

    return provider.defaultModel ? `${provider.name} · ${provider.defaultModel}` : provider.name;
  }

  private renderProviderSection(containerEl: HTMLElement): void {
    const toolbar = containerEl.createDiv({ cls: "ai-second-brain-provider-toolbar" });
    const toolbarCopy = toolbar.createDiv({ cls: "ai-second-brain-provider-toolbar-copy" });
    toolbarCopy.createDiv({ cls: "ai-second-brain-provider-toolbar-title", text: "服务商配置" });
    toolbarCopy.createDiv({
      cls: "ai-second-brain-provider-toolbar-description",
      text: "可以添加多套云端或本地 API，并为不同任务指定默认服务。"
    });
    const addButton = this.createIconButton(toolbar, "plus", "添加服务商", "mod-cta ai-second-brain-provider-add");
    addButton.addEventListener("click", () => {
      void this.openProviderCreator();
    });

    const routing = containerEl.createDiv({ cls: "ai-second-brain-provider-routing" });
    const enabledProviders = this.plugin.settings.providers.filter((provider) => provider.enabled);
    this.renderProviderRoute(
      routing,
      "默认聊天服务",
      "用于侧边栏问答和多轮对话。",
      this.plugin.settings.defaultChatProviderId,
      enabledProviders,
      async (providerId) => {
        this.plugin.settings.defaultChatProviderId = providerId;
        await this.plugin.saveSettings();
        this.display();
      }
    );
    this.renderProviderRoute(
      routing,
      "默认编辑服务",
      "用于改写、生成内容和图谱结构。",
      this.plugin.settings.defaultEditProviderId,
      enabledProviders,
      async (providerId) => {
        this.plugin.settings.defaultEditProviderId = providerId;
        await this.plugin.saveSettings();
        this.display();
      }
    );

    if (this.plugin.settings.providers.length === 0) {
      const empty = containerEl.createDiv({ cls: "ai-second-brain-provider-empty" });
      const icon = empty.createDiv({ cls: "ai-second-brain-provider-empty-icon" });
      setIcon(icon, "server-off");
      empty.createDiv({ cls: "ai-second-brain-provider-empty-title", text: "还没有 AI 服务商" });
      empty.createDiv({
        cls: "ai-second-brain-provider-empty-description",
        text: "添加第一套 API 后，可以继续配置更多服务并分别分配任务。"
      });
      return;
    }

    for (const provider of this.plugin.settings.providers) {
      this.renderProvider(containerEl, provider);
    }
  }

  private renderProviderRoute(
    containerEl: HTMLElement,
    name: string,
    description: string,
    value: string,
    providers: AIProviderConfig[],
    onChange: (providerId: string) => Promise<void>
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addDropdown((dropdown) => {
        dropdown.addOption("", providers.length > 0 ? "自动选择可用服务" : "暂无已启用服务");
        for (const provider of providers) {
          dropdown.addOption(provider.id, `${provider.name} · ${provider.defaultModel || "未设置模型"}`);
        }
        dropdown.setValue(providers.some((provider) => provider.id === value) ? value : "");
        dropdown.onChange((providerId) => {
          void onChange(providerId);
        });
      });
  }

  private async openProviderCreator(): Promise<void> {
    const provider = await configureProvider(this.app);

    if (!provider) {
      return;
    }

    this.expandedCards.add(`provider:${provider.id}`);
    this.initializedCards.add(`provider:${provider.id}`);
    await this.plugin.addProvider(provider);
    this.display();
  }

  private renderDiagramSection(containerEl: HTMLElement): void {
    const integration = containerEl.createDiv({ cls: "ai-second-brain-diagram-integration" });
    const integrationIcon = integration.createDiv({ cls: "ai-second-brain-diagram-integration-icon" });
    setIcon(integrationIcon, this.plugin.diagramService.isExcalidrawAvailable() ? "badge-check" : "circle-alert");
    const integrationCopy = integration.createDiv({ cls: "ai-second-brain-diagram-integration-copy" });
    integrationCopy.createDiv({
      cls: "ai-second-brain-diagram-integration-title",
      text: this.plugin.diagramService.isExcalidrawAvailable() ? "Excalidraw 已连接" : "Excalidraw 未连接"
    });
    integrationCopy.createDiv({
      cls: "ai-second-brain-muted",
      text: this.plugin.diagramService.isExcalidrawAvailable()
        ? "图谱将创建为可继续编辑的 Excalidraw 文件。"
        : "生成图谱时将自动降级为 Mermaid 笔记。"
    });

    new Setting(containerEl)
      .setName("绘图文件夹")
      .setDesc("Excalidraw 图谱在 Vault 中的保存位置。")
      .addText((text) =>
        text.setPlaceholder("AI Second Brain/Diagrams")
          .setValue(this.plugin.settings.diagramFolder)
          .onChange((value) => {
            this.plugin.settings.diagramFolder = value.trim() || "AI Second Brain/Diagrams";
            debouncedSave(() => this.plugin.saveSettings());
          })
      );

    new Setting(containerEl)
      .setName("最大节点数")
      .setDesc("限制单次绘图复杂度，避免生成难以阅读的大图。")
      .addSlider((slider) =>
        slider.setLimits(8, 40, 1)
          .setValue(this.plugin.settings.diagramMaxNodes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.diagramMaxNodes = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认嵌入当前笔记")
      .setDesc("创建绘图后，在发起操作的笔记光标处插入嵌入链接。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.diagramAutoEmbed).onChange(async (value) => {
          this.plugin.settings.diagramAutoEmbed = value;
          await this.plugin.saveSettings();
        })
      );
  }

  private renderGuideSection(containerEl: HTMLElement): void {
    const quickStart = containerEl.createDiv({ cls: "ai-second-brain-guide-block" });
    quickStart.createDiv({ cls: "ai-second-brain-guide-heading", text: "快速开始" });
    const steps = quickStart.createDiv({ cls: "ai-second-brain-guide-steps" });
    this.renderGuideStep(steps, "1", "配置模型", "在“AI 服务商”中添加 API，启用后分别指定聊天和编辑服务。");
    this.renderGuideStep(steps, "2", "授权笔记", "在“上下文范围”中选择文件、文件夹、Tag 或路径规则，并确认云端访问权限。");
    this.renderGuideStep(steps, "3", "开始使用", "点击左侧功能区的脑图标打开对话；当前范围会显示在对话顶部。");

    const workflows = containerEl.createDiv({ cls: "ai-second-brain-guide-block" });
    workflows.createDiv({ cls: "ai-second-brain-guide-heading", text: "核心工作流" });
    const list = workflows.createDiv({ cls: "ai-second-brain-guide-list" });
    this.renderGuideItem(list, "message-circle", "对话与上下文", "直接提问或切换跟随、锁定、手动范围。首次使用或范围变化时确认本轮文件，锁定文件会持续参与对话。");
    this.renderGuideItem(list, "text-cursor-input", "选区 AI", "选中文字后使用浮动工具条进行解释、总结、改写、翻译、扩写或缩写；结果确认后再插入或替换原文。");
    this.renderGuideItem(list, "folder-search", "跨笔记分析", "可直接说“分析某文件夹下的所有笔记”。插件会识别真实文件夹，并检查潜在双链、重复、冲突、缺少出处及可合并内容。");
    this.renderGuideItem(list, "files", "批量修改计划", "在 AI 回复下点击“创建修改计划”，逐项查看 Diff 并勾选应用。删除默认不选；最近一次批次可通过命令面板撤销。");
    this.renderGuideItem(list, "workflow", "图表与图谱", "要求生成流程图、时间线、决策树或架构图时会输出 Mermaid 成果块；也可生成可继续编辑的 Excalidraw 图谱。");
    this.renderGuideItem(list, "quote", "引用与保存", "悬浮编号查看来源，点击可定位原文。来源变化会提示过期；“保存为带引用笔记”会生成标准 Markdown 脚注。");

    const safety = containerEl.createDiv({ cls: "ai-second-brain-guide-safety" });
    const safetyIcon = safety.createDiv({ cls: "ai-second-brain-guide-safety-icon" });
    setIcon(safetyIcon, "shield-check");
    const safetyCopy = safety.createDiv({ cls: "ai-second-brain-guide-safety-copy" });
    safetyCopy.createDiv({ cls: "ai-second-brain-guide-safety-title", text: "隐私与安全" });
    safetyCopy.createDiv({
      cls: "ai-second-brain-guide-safety-text",
      text: "文件检索与索引在本地完成，只有当前授权且经确认的相关内容会发送给所选 AI 服务。所有写入操作都需要用户确认；批量修改会校验快照并保留最近一次撤销记录。"
    });
  }

  private renderGuideSubview(containerEl: HTMLElement): void {
    containerEl.addClass("is-subview");
    const toolbar = containerEl.createDiv({ cls: "ai-second-brain-settings-subview-toolbar" });
    const backButton = this.createIconButton(toolbar, "arrow-left", "返回设置", "ai-second-brain-settings-subview-back");
    backButton.addEventListener("click", () => {
      this.activeSubview = undefined;
      this.display();
      this.containerEl.scrollTop = 0;
    });
    const heading = toolbar.createDiv({ cls: "ai-second-brain-settings-subview-heading" });
    heading.createEl("h2", { text: "使用指南" });
    heading.createEl("p", { text: "从首次配置到跨笔记分析、安全修改和引用追踪。" });

    const content = containerEl.createDiv({ cls: "ai-second-brain-settings-subview-content" });
    const intro = content.createDiv({ cls: "ai-second-brain-settings-subview-intro" });
    const introIcon = intro.createDiv({ cls: "ai-second-brain-settings-subview-intro-icon" });
    setIcon(introIcon, "book-open-check");
    const introCopy = intro.createDiv({ cls: "ai-second-brain-settings-subview-intro-copy" });
    introCopy.createDiv({ cls: "ai-second-brain-settings-subview-intro-title", text: "把 AI 放进笔记工作流" });
    introCopy.createDiv({
      cls: "ai-second-brain-settings-subview-intro-text",
      text: "先确定模型与授权范围，再通过对话、选区工具和修改计划完成从检索到写入的闭环。"
    });
    this.renderGuideSection(content);
  }

  private renderGuideStep(
    containerEl: HTMLElement,
    number: string,
    title: string,
    description: string
  ): void {
    const item = containerEl.createDiv({ cls: "ai-second-brain-guide-step" });
    const marker = item.createDiv({ cls: "ai-second-brain-guide-step-marker" });
    marker.createSpan({ text: number });
    const copy = item.createDiv({ cls: "ai-second-brain-guide-step-copy" });
    copy.createDiv({ cls: "ai-second-brain-guide-step-title", text: title });
    copy.createDiv({ cls: "ai-second-brain-guide-step-description", text: description });
  }

  private renderGuideItem(containerEl: HTMLElement, iconName: IconName, title: string, description: string): void {
    const item = containerEl.createDiv({ cls: "ai-second-brain-guide-item" });
    const icon = item.createDiv({ cls: "ai-second-brain-guide-item-icon" });
    setIcon(icon, iconName);
    const copy = item.createDiv({ cls: "ai-second-brain-guide-item-copy" });
    copy.createDiv({ cls: "ai-second-brain-guide-item-title", text: title });
    copy.createDiv({ cls: "ai-second-brain-guide-item-description", text: description });
  }

  private renderProvider(containerEl: HTMLElement, provider: AIProviderConfig): void {
    const group = this.createSettingsDisclosure(
      containerEl,
      `provider:${provider.id}`,
      "server",
      provider.name || "未命名服务商",
      `${providerTypeLabel(provider.type)} · ${provider.defaultModel || "未设置模型"}`,
      this.providerStatusLabel(provider),
      provider.id === this.plugin.settings.defaultChatProviderId || provider.id === this.plugin.settings.defaultEditProviderId
    );

    new Setting(group)
      .setName("启用")
      .addToggle((toggle) =>
        toggle.setValue(provider.enabled).onChange(async (value) => {
          provider.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(group)
      .setName("名称")
      .addText((text) =>
        text.setValue(provider.name).onChange(async (value) => {
          provider.name = value;
          debouncedSave(() => this.plugin.saveSettings());
        })
      );

    new Setting(group)
      .setName("Base URL")
      .addText((text) =>
        text.setPlaceholder("https://api.openai.com/v1")
          .setValue(provider.baseUrl || "")
          .onChange(async (value) => {
            provider.baseUrl = value.trim();
            debouncedSave(() => this.plugin.saveSettings());
          })
      );

    new Setting(group)
      .setName("API Key")
      .setDesc(provider.type === "ollama" ? "本地 Ollama 通常不需要填写。" : "Key 会保存在当前 Obsidian 插件数据中。")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(provider.type === "ollama" ? "可留空" : "sk-...");
        text.setValue(provider.apiKey || "");
        text.onChange(async (value) => {
          provider.apiKey = value.trim();
          debouncedSave(() => this.plugin.saveSettings());
        });
      });

    new Setting(group)
      .setName("默认模型")
      .addText((text) =>
        text.setValue(provider.defaultModel).onChange(async (value) => {
          provider.defaultModel = value.trim();
          debouncedSave(() => this.plugin.saveSettings());
        })
      );

    new Setting(group)
      .setName("温度")
      .setDesc("数值越高，回答越发散。")
      .addSlider((slider) =>
        slider
          .setLimits(0, 2, 0.1)
          .setValue(provider.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            provider.temperature = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(group)
      .setName("流式输出")
      .setDesc("开启后，侧边栏会逐字显示模型回答。")
      .addToggle((toggle) =>
        toggle.setValue(provider.stream).onChange(async (value) => {
          provider.stream = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(group)
      .setName("配置操作")
      .setDesc("复制会保留接口参数和 Key，但不会改变当前默认任务路由。")
      .addButton((button) =>
        button
          .setIcon("copy-plus")
          .setTooltip("复制服务商配置")
          .onClick(async () => {
            const copy: AIProviderConfig = {
              ...provider,
              id: `${provider.type}-${crypto.randomUUID()}`,
              name: `${provider.name} 副本`
            };
            this.expandedCards.add(`provider:${copy.id}`);
            this.initializedCards.add(`provider:${copy.id}`);
            await this.plugin.addProvider(copy);
            this.display();
          })
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("删除")
          .onClick(async () => {
            if (!confirm(`确定要删除服务商「${provider.name || "未命名服务商"}」吗？`)) {
              return;
            }
            await this.plugin.removeProvider(provider.id);
            this.display();
          })
      );
  }

  private providerStatusLabel(provider: AIProviderConfig): string {
    if (!provider.enabled) {
      return "已停用";
    }

    const roles: string[] = [];
    if (provider.id === this.plugin.settings.defaultChatProviderId) {
      roles.push("聊天");
    }
    if (provider.id === this.plugin.settings.defaultEditProviderId) {
      roles.push("编辑");
    }
    return roles.length > 0 ? `默认：${roles.join("、")}` : "已启用";
  }

  private renderContextSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("自动识别文件")
      .setDesc("对话处于“跟随”状态时，切换笔记、Canvas 或 Excalidraw 会同步更新下一轮上下文。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRecognizeActiveFile).onChange(async (value) => {
          this.plugin.settings.autoRecognizeActiveFile = value;
          if (!value) {
            const activeFile = this.app.workspace.getActiveFile();
            const session = this.plugin.getActiveChatSession();
            if (session.contextMode === "follow" && isContextFile(activeFile)) {
              session.contextFilePath = activeFile.path;
            }
          }
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("新增上下文范围")
      .setDesc("可以用文件、文件夹、标签或路径规则控制 AI 可访问内容。")
      .addButton((button) =>
        button.setButtonText("文件").onClick(async () => {
          await this.plugin.addContextScope(this.createContextScope("files"));
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("文件夹").onClick(async () => {
          await this.plugin.addContextScope(this.createContextScope("folders"));
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("标签").onClick(async () => {
          await this.plugin.addContextScope(this.createContextScope("tags"));
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("路径规则").onClick(async () => {
          await this.plugin.addContextScope(this.createContextScope("rules"));
          this.display();
        })
      );

    for (const scope of this.plugin.settings.contextScopes) {
      this.renderContextScope(containerEl, scope);
    }
  }

  private renderContextScope(containerEl: HTMLElement, scope: ContextScope): void {
    const fileCount = this.plugin.countFilesInContextScope(scope);
    const group = this.createSettingsDisclosure(
      containerEl,
      `context:${scope.id}`,
      scope.mode === "current-file" ? "file-text" : "folder-lock",
      scope.name || "未命名上下文",
      `${scopeModeLabel(scope.mode)} · ${fileCount} 个文件`,
      scope.allowCloudModels ? "允许云端" : "仅限本地",
      scope.id === this.plugin.settings.activeContextScopeId
    );

    new Setting(group)
      .setName("名称")
      .addText((text) =>
        text.setValue(scope.name).onChange(async (value) => {
          scope.name = value.trim() || "未命名上下文";
          debouncedSave(() => this.plugin.saveSettings());
        })
      );

    if (scope.id !== "current-file") {
      new Setting(group)
        .setName("范围类型")
        .addDropdown((dropdown) => {
          dropdown.addOption("files", "指定文件");
          dropdown.addOption("folders", "文件夹");
          dropdown.addOption("tags", "标签");
          dropdown.addOption("rules", "路径规则");
          dropdown.setValue(scope.mode);
          dropdown.onChange(async (value) => {
            scope.mode = value as ContextScopeMode;
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    new Setting(group)
      .setName("允许云端模型")
      .setDesc("关闭后，此范围后续可限制为仅本地模型使用。")
      .addToggle((toggle) =>
        toggle.setValue(scope.allowCloudModels).onChange(async (value) => {
          scope.allowCloudModels = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (scope.mode === "files") {
      this.renderListSetting(group, "文件路径", "逐条添加笔记、Canvas 或 Excalidraw 文件。", scope.files, async (value) => {
        scope.files = value;
        await this.plugin.saveSettings();
      }, {
        picker: "markdown-file",
        placeholder: "Projects/Plan.md 或 Board.canvas"
      });
    }

    if (scope.mode === "folders") {
      this.renderListSetting(group, "文件夹路径", "逐条添加文件夹路径，例如 Projects。", scope.folders, async (value) => {
        scope.folders = value;
        await this.plugin.saveSettings();
      }, {
        picker: "folder",
        placeholder: "Projects"
      });
    }

    if (scope.mode === "tags") {
      this.renderListSetting(group, "标签", "逐条添加标签，可以带 #，例如 #project。", scope.tags, async (value) => {
        scope.tags = value.map((tag) => tag.replace(/^#/, ""));
        await this.plugin.saveSettings();
      }, {
        placeholder: "#project",
        normalize: normalizeTag,
        displayValue: (value) => `#${normalizeTag(value)}`
      });
    }

    if (scope.mode === "rules") {
      this.renderListSetting(group, "路径包含规则", "逐条添加路径关键词，文件路径包含任一规则即会纳入。", scope.pathRules, async (value) => {
        scope.pathRules = value;
        await this.plugin.saveSettings();
      }, {
        placeholder: "Projects/"
      });
    }

    if (scope.mode !== "current-file") {
      this.renderListSetting(group, "排除规则", "逐条添加路径关键词，匹配后会从当前范围中排除。", scope.excludeRules, async (value) => {
        scope.excludeRules = value;
        await this.plugin.saveSettings();
      }, {
        placeholder: "Archive/"
      });
    }

    if (scope.id !== "current-file") {
      new Setting(group)
        .setName("删除范围")
        .addButton((button) =>
          button
            .setWarning()
            .setButtonText("删除")
            .onClick(async () => {
              if (!confirm(`确定要删除上下文范围「${scope.name}」吗？`)) {
                return;
              }
              await this.plugin.removeContextScope(scope.id);
              this.display();
            })
        );
    }
  }

  private renderTemplateSection(containerEl: HTMLElement): void {
    containerEl.createEl("p", {
      cls: "ai-second-brain-muted",
      text: "模板支持 {{selection}}、{{noteTitle}}、{{filePath}} 占位符。选中文本操作会按任务类型调用对应模板。"
    });

    new Setting(containerEl)
      .setName("新增自定义模板")
      .setDesc("同一任务有多个模板时，靠后的自定义模板会优先用于命令和选区工具条。")
      .addButton((button) =>
        button.setButtonText("添加").onClick(async () => {
          this.plugin.settings.promptTemplates.push(this.createPromptTemplate());
          await this.plugin.saveSettings();
          this.display();
        })
      );

    for (const template of this.plugin.settings.promptTemplates) {
      this.renderPromptTemplate(containerEl, template);
    }
  }

  private renderPromptTemplate(containerEl: HTMLElement, template: PromptTemplate): void {
    const group = this.createSettingsDisclosure(
      containerEl,
      `template:${template.id}`,
      "scroll-text",
      template.name || "未命名模板",
      TEMPLATE_TASK_DISPLAY[template.task],
      template.builtIn ? "内置" : "自定义",
      !template.builtIn
    );

    new Setting(group)
      .setName("名称")
      .addText((text) =>
        text.setValue(template.name).onChange(async (value) => {
          template.name = value.trim() || "未命名模板";
          debouncedSave(() => this.plugin.saveSettings());
        })
      );

    new Setting(group)
      .setName("任务类型")
      .setDesc("内置模板的任务类型固定，用于命令面板和选区工具条路由。")
      .addDropdown((dropdown) => {
        this.addTemplateTaskOptions(dropdown);
        dropdown.setValue(template.task);
        dropdown.setDisabled(template.builtIn);
        dropdown.onChange(async (value) => {
          template.task = value as PromptTemplateTask;
          await this.plugin.saveSettings();
        });
      });

    new Setting(group)
      .setName("Provider")
      .setDesc("留空时使用默认编辑服务。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "默认编辑服务");

        for (const provider of this.plugin.settings.providers) {
          dropdown.addOption(provider.id, provider.name || provider.id);
        }

        dropdown.setValue(template.providerId || "");
        dropdown.onChange(async (value) => {
          template.providerId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(group)
      .setName("模型")
      .setDesc("留空时使用 Provider 的默认模型。")
      .addText((text) =>
        text.setPlaceholder("例如 gpt-4o-mini")
          .setValue(template.model || "")
          .onChange(async (value) => {
            template.model = value.trim();
            debouncedSave(() => this.plugin.saveSettings());
          })
      );

    new Setting(group)
      .setName("温度")
      .setDesc("模板级温度覆盖。")
      .addSlider((slider) =>
        slider
          .setLimits(0, 2, 0.1)
          .setValue(template.temperature ?? 0.7)
          .setDynamicTooltip()
          .onChange(async (value) => {
            template.temperature = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(group)
      .setName("使用当前上下文")
      .setDesc("开启后，模板请求会检索当前授权笔记范围。")
      .addToggle((toggle) =>
        toggle.setValue(template.useContext).onChange(async (value) => {
          template.useContext = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(group)
      .setName("绑定上下文")
      .setDesc("留空时使用当前激活范围。仅在开启上下文时生效。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "当前激活范围");

        for (const scope of this.plugin.settings.contextScopes) {
          dropdown.addOption(scope.id, scope.name);
        }

        dropdown.setValue(template.contextScopeId || "");
        dropdown.onChange(async (value) => {
          template.contextScopeId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(group)
      .setName("输出方式")
      .addDropdown((dropdown) => {
        dropdown.addOption("append-block", "追加 AI 说明");
        dropdown.addOption("replace-selection", "预览后替换选区");
        dropdown.setValue(template.outputMode);
        dropdown.onChange(async (value) => {
          template.outputMode = value as PromptTemplateOutputMode;
          await this.plugin.saveSettings();
        });
      });

    new Setting(group)
      .setName("Prompt")
      .setDesc("可以使用占位符引用选中文本和当前文件信息。")
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.setValue(template.prompt);
        text.onChange(async (value) => {
          template.prompt = value;
          debouncedSave(() => this.plugin.saveSettings());
        });
      });

    if (template.builtIn) {
      new Setting(group)
        .setName("恢复内置模板")
        .addButton((button) =>
          button.setButtonText("恢复").onClick(async () => {
            const builtIn = BUILT_IN_PROMPT_TEMPLATES.find((item) => item.id === template.id);

            if (!builtIn) {
              return;
            }

            Object.assign(template, builtIn);
            await this.plugin.saveSettings();
            this.display();
          })
        );
    } else {
      new Setting(group)
        .setName("删除模板")
        .addButton((button) =>
          button
            .setWarning()
            .setButtonText("删除")
            .onClick(async () => {
              if (!confirm(`确定要删除模板「${template.name}」吗？`)) {
                return;
              }
              this.plugin.settings.promptTemplates = this.plugin.settings.promptTemplates.filter(
                (item) => item.id !== template.id
              );
              await this.plugin.saveSettings();
              this.display();
            })
        );
    }
  }

  private renderListSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    values: string[],
    onChange: (values: string[]) => Promise<void>,
    options: ListSettingOptions = {}
  ): void {
    const normalize = options.normalize || normalizeListItem;
    const displayValue = options.displayValue || ((value: string) => value);
    const currentValues = uniqueValues(values.map(normalize));
    const group = containerEl.createDiv({ cls: "ai-second-brain-list-setting" });
    const header = group.createDiv({ cls: "ai-second-brain-list-setting-header" });
    const copy = header.createDiv({ cls: "ai-second-brain-list-setting-copy" });
    copy.createDiv({ cls: "ai-second-brain-list-setting-title", text: name });
    copy.createDiv({ cls: "ai-second-brain-list-setting-desc", text: desc });
    header.createSpan({ cls: "ai-second-brain-badge", text: `${currentValues.length} 条` });

    const saveValues = async (nextValues: string[]) => {
      await onChange(uniqueValues(nextValues.map(normalize)));
      this.display();
    };

    const list = group.createDiv({ cls: "ai-second-brain-list-items" });

    if (currentValues.length === 0) {
      list.createDiv({ cls: "ai-second-brain-list-empty", text: "尚未添加规则。" });
    } else {
      for (const value of currentValues) {
        const item = list.createDiv({ cls: "ai-second-brain-list-item" });
        item.createDiv({ cls: "ai-second-brain-list-value", text: displayValue(value) });
        const removeButton = this.createIconButton(item, "x", "移除", "ai-second-brain-list-remove");
        removeButton.addEventListener("click", () => {
          void saveValues(currentValues.filter((itemValue) => itemValue !== value));
        });
      }
    }

    const controls = group.createDiv({ cls: "ai-second-brain-list-controls" });
    const input = controls.createEl("input", {
      cls: "ai-second-brain-list-input",
      attr: {
        type: "text",
        placeholder: options.placeholder || "输入一条规则"
      }
    });
    const addValue = () => {
      const nextValue = normalize(input.value);

      if (!nextValue) {
        return;
      }

      input.value = "";
      void saveValues([...currentValues, nextValue]);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addValue();
      }
    });

    const addButton = this.createIconButton(controls, "plus", "添加", "ai-second-brain-list-add");
    addButton.addEventListener("click", addValue);

    if (options.picker === "markdown-file") {
      const pickButton = this.createIconButton(controls, "file-search", "选择文件", "ai-second-brain-list-pick");
      pickButton.addEventListener("click", () => {
        new MarkdownFileSuggestModal(this.app, currentValues, (file) => {
          void saveValues([...currentValues, file.path]);
        }).open();
      });
    }

    if (options.picker === "folder") {
      const pickButton = this.createIconButton(controls, "folder-search", "选择文件夹", "ai-second-brain-list-pick");
      pickButton.addEventListener("click", () => {
        new FolderSuggestModal(this.app, currentValues, (folder) => {
          void saveValues([...currentValues, folder.path]);
        }).open();
      });
    }
  }

  private createIconButton(containerEl: HTMLElement, icon: IconName, text: string, className = ""): HTMLButtonElement {
    const button = containerEl.createEl("button", {
      cls: ["ai-second-brain-icon-button", className].filter(Boolean).join(" "),
      attr: { type: "button", title: text, "aria-label": text }
    });
    const iconEl = button.createSpan({ cls: "ai-second-brain-button-icon" });
    setIcon(iconEl, icon);
    button.createSpan({ cls: "ai-second-brain-button-label", text });
    return button;
  }

  private createSettingsDisclosure(
    containerEl: HTMLElement,
    key: string,
    iconName: IconName,
    title: string,
    description: string,
    status: string,
    defaultOpen: boolean
  ): HTMLElement {
    if (!this.initializedCards.has(key)) {
      this.initializedCards.add(key);
      if (defaultOpen) {
        this.expandedCards.add(key);
      }
    }

    const details = containerEl.createEl("details", {
      cls: "ai-second-brain-settings-card ai-second-brain-settings-disclosure"
    });
    details.open = this.expandedCards.has(key);
    const summary = details.createEl("summary", { cls: "ai-second-brain-settings-disclosure-summary" });
    const icon = summary.createSpan({ cls: "ai-second-brain-settings-disclosure-icon" });
    setIcon(icon, iconName);
    const copy = summary.createSpan({ cls: "ai-second-brain-settings-disclosure-copy" });
    copy.createSpan({ cls: "ai-second-brain-settings-disclosure-title", text: title });
    copy.createSpan({ cls: "ai-second-brain-settings-disclosure-description", text: description });
    summary.createSpan({ cls: "ai-second-brain-badge ai-second-brain-settings-disclosure-status", text: status });
    const chevron = summary.createSpan({ cls: "ai-second-brain-settings-disclosure-chevron" });
    setIcon(chevron, "chevron-down");
    details.addEventListener("toggle", () => {
      if (details.open) {
        this.expandedCards.add(key);
      } else {
        this.expandedCards.delete(key);
      }
    });
    return details.createDiv({ cls: "ai-second-brain-settings-disclosure-body" });
  }

  private createContextScope(mode: Exclude<ContextScopeMode, "current-file">): ContextScope {
    const id = `${mode}-${crypto.randomUUID()}`;

    return {
      id,
      name: scopeModeLabel(mode),
      mode,
      files: [],
      folders: [],
      tags: [],
      pathRules: [],
      excludeRules: [],
      allowCloudModels: true
    };
  }

  private createPromptTemplate(): PromptTemplate {
    return {
      id: `custom-template-${crypto.randomUUID()}`,
      name: "自定义模板",
      task: "selection-rewrite",
      prompt: "请处理下面这段内容，只输出处理后的正文：\n\n{{selection}}",
      providerId: "",
      model: "",
      contextScopeId: "",
      temperature: 0.7,
      useContext: false,
      outputMode: "replace-selection",
      builtIn: false
    };
  }

  private addTemplateTaskOptions(dropdown: { addOption(value: string, display: string): unknown }): void {
    for (const [value, display] of Object.entries(TEMPLATE_TASK_DISPLAY)) {
      dropdown.addOption(value, display);
    }
  }
}

function normalizeListItem(value: string): string {
  return value.trim();
}

function providerTypeLabel(type: AIProviderType): string {
  if (type === "openai-compatible") {
    return "OpenAI-compatible";
  }

  if (type === "anthropic") {
    return "Anthropic";
  }

  return "Ollama";
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#/, "");
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeListItem).filter(Boolean)));
}

class MarkdownFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly existingPaths: string[],
    private readonly onChoose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("选择 AI 可访问的笔记、Canvas 或 Excalidraw 文件");
  }

  getItems(): TFile[] {
    const existing = new Set(this.existingPaths);
    return this.app.vault
      .getAllLoadedFiles()
      .filter(isContextFile)
      .filter((file) => !existing.has(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly existingPaths: string[],
    private readonly onChoose: (folder: TFolder) => void
  ) {
    super(app);
    this.setPlaceholder("选择 AI 可访问的文件夹");
  }

  getItems(): TFolder[] {
    const existing = new Set(this.existingPaths);
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && !file.isRoot() && !existing.has(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}
