import { App, FuzzySuggestModal, IconName, Notice, PluginSettingTab, setIcon, Setting, TFile, TFolder } from "obsidian";
import { ContextScope, ContextScopeMode, scopeModeLabel } from "../context/scope-types";
import type ObsidianAIPlugin from "../main";
import { AIProviderConfig, AIProviderType } from "../providers/types";
import { BUILT_IN_PROMPT_TEMPLATES } from "../templates/built-in-templates";
import { PromptTemplate, PromptTemplateOutputMode, PromptTemplateTask } from "../templates/types";

const TEMPLATE_TASK_LABELS: Record<PromptTemplateTask, string> = {
  "selection-explain": "解释",
  "selection-summarize": "总结",
  "selection-rewrite": "改写",
  "selection-translate": "翻译",
  "selection-expand": "扩写",
  "selection-condense": "缩写",
};

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
  constructor(app: App, private readonly plugin: ObsidianAIPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ai-second-brain-settings");

    this.renderSettingsHero(containerEl);
    this.renderControlCenter(containerEl);
    this.renderSettingsSection(containerEl, "server", "AI 服务商", "管理模型提供方、默认模型和任务分工。", (section) => {
      this.renderProviderSection(section);
    });
    this.renderSettingsSection(containerEl, "folder-lock", "上下文范围", "精确控制 AI 可以读取哪些 Markdown 文件。", (section) => {
      this.renderContextSection(section);
    });
    this.renderSettingsSection(containerEl, "scroll-text", "Prompt 模板", "维护右键菜单与命令面板使用的任务提示词。", (section) => {
      this.renderTemplateSection(section);
    });
    this.renderSettingsSection(containerEl, "workflow", "视觉图谱", "配置 Excalidraw 图谱的保存位置和生成边界。", (section) => {
      this.renderDiagramSection(section);
    });
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

  private renderSettingsSection(
    containerEl: HTMLElement,
    iconName: IconName,
    title: string,
    description: string,
    renderBody: (section: HTMLElement) => void
  ): void {
    const section = containerEl.createDiv({ cls: "ai-second-brain-settings-section" });
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
    const card = containerEl.createDiv({ cls: "ai-second-brain-control-center" });
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
    this.renderControlStat(stats, "授权文件", `${activeFiles.length}`, activeFiles.length > 0 ? "个 Markdown 文件" : "当前范围为空");
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
        text: "当前范围没有命中任何 Markdown 文件。AI 不会读取笔记内容。"
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
    if (this.plugin.settings.providers.length === 0) {
      containerEl.createEl("p", {
        cls: "ai-second-brain-muted",
        text: "还没有配置服务商。可以先添加一个 OpenAI-compatible 或 Ollama 服务。"
      });
    }

    for (const provider of this.plugin.settings.providers) {
      this.renderProvider(containerEl, provider);
    }

    new Setting(containerEl)
      .setName("添加 OpenAI-compatible 服务")
      .setDesc("适用于 OpenAI、DeepSeek 或兼容 /chat/completions 的服务。")
      .addButton((button) =>
        button.setButtonText("添加").onClick(async () => {
          const provider = this.createProvider("openai-compatible");
          provider.name = "OpenAI-compatible";
          provider.baseUrl = "https://api.openai.com/v1";
          provider.defaultModel = "gpt-4o-mini";
          await this.plugin.addProvider(provider);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("添加 Ollama 服务")
      .setDesc("适用于本地 Ollama 模型。")
      .addButton((button) =>
        button.setButtonText("添加").onClick(async () => {
          const provider = this.createProvider("ollama");
          provider.name = "Ollama";
          provider.baseUrl = "http://localhost:11434";
          provider.defaultModel = "llama3.1";
          await this.plugin.addProvider(provider);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("添加 Anthropic Claude 服务")
      .setDesc("适用于 Anthropic Messages API。")
      .addButton((button) =>
        button.setButtonText("添加").onClick(async () => {
          const provider = this.createProvider("anthropic");
          provider.name = "Anthropic Claude";
          provider.baseUrl = "https://api.anthropic.com/v1";
          provider.defaultModel = "claude-3-5-sonnet-latest";
          await this.plugin.addProvider(provider);
          this.display();
        })
      );
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

  private renderProvider(containerEl: HTMLElement, provider: AIProviderConfig): void {
    const group = containerEl.createDiv({ cls: "ai-second-brain-settings-card" });
    group.createEl("h4", { text: provider.name || "未命名服务商" });

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
      .setName("设为默认聊天服务")
      .addButton((button) =>
        button.setButtonText("设为默认").onClick(async () => {
          this.plugin.settings.defaultChatProviderId = provider.id;
          await this.plugin.saveSettings();
          new Notice(`已将 ${provider.name} 设为默认聊天服务。`);
          this.display();
        })
      );

    new Setting(group)
      .setName("设为默认编辑服务")
      .addButton((button) =>
        button.setButtonText("设为默认").onClick(async () => {
          this.plugin.settings.defaultEditProviderId = provider.id;
          await this.plugin.saveSettings();
          new Notice(`已将 ${provider.name} 设为默认编辑服务。`);
          this.display();
        })
      );

    new Setting(group)
      .setName("删除服务商")
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

  private renderContextSection(containerEl: HTMLElement): void {
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
    const group = containerEl.createDiv({ cls: "ai-second-brain-settings-card" });
    const fileCount = this.plugin.countFilesInContextScope(scope);
    const title = group.createDiv({ cls: "ai-second-brain-settings-card-title" });
    title.createEl("h4", { text: scope.name || "未命名上下文" });
    title.createSpan({
      cls: "ai-second-brain-badge",
      text: `${scopeModeLabel(scope.mode)} · ${fileCount} 个文件`
    });

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
      this.renderListSetting(group, "文件路径", "逐条添加 Markdown 文件路径，例如 Projects/Plan.md。", scope.files, async (value) => {
        scope.files = value;
        await this.plugin.saveSettings();
      }, {
        picker: "markdown-file",
        placeholder: "Projects/Plan.md"
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
      .setDesc("同一任务有多个模板时，靠后的自定义模板会优先用于命令和右键菜单。")
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
    const group = containerEl.createDiv({ cls: "ai-second-brain-settings-card" });
    const title = group.createDiv({ cls: "ai-second-brain-settings-card-title" });
    title.createEl("h4", { text: template.name || "未命名模板" });
    title.createSpan({
      cls: "ai-second-brain-badge",
      text: TEMPLATE_TASK_LABELS[template.task]
    });

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
      .setDesc("内置模板的任务类型固定，用于命令面板和右键菜单路由。")
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
      cls: ["ai-second-brain-icon-button", className].filter(Boolean).join(" ")
    });
    const iconEl = button.createSpan({ cls: "ai-second-brain-button-icon" });
    setIcon(iconEl, icon);
    button.createSpan({ cls: "ai-second-brain-button-label", text });
    return button;
  }

  private createProvider(type: AIProviderType): AIProviderConfig {
    const id = `${type}-${crypto.randomUUID()}`;

    return {
      id,
      name: type,
      type,
      baseUrl: "",
      apiKey: "",
      defaultModel: "",
      temperature: 0.7,
      stream: true,
      enabled: true
    };
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
    this.setPlaceholder("选择 AI 可访问的 Markdown 文件");
  }

  getItems(): TFile[] {
    const existing = new Set(this.existingPaths);
    return this.app.vault
      .getMarkdownFiles()
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
