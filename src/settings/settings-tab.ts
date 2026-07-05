import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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

    containerEl.createEl("h2", { text: "AI Second Brain" });
    containerEl.createEl("p", {
      cls: "ai-second-brain-setting-description",
      text: "配置 AI 服务商、默认模型和上下文访问范围。插件只会读取当前授权范围内的笔记。"
    });

    this.renderProviderSection(containerEl);
    this.renderContextSection(containerEl);
    this.renderTemplateSection(containerEl);
  }

  private renderProviderSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "AI 服务商" });

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

  private renderProvider(containerEl: HTMLElement, provider: AIProviderConfig): void {
    const group = containerEl.createDiv({ cls: "ai-second-brain-settings-card" });
    group.createEl("h4", { text: provider.name || "未命名服务商" });

    new Setting(group)
      .setName("启用")
      .addToggle((toggle) =>
        toggle.setValue(provider.enabled).onChange(async (value) => {
          provider.enabled = value;
          await this.plugin.saveSettings();
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
        })
      );

    new Setting(group)
      .setName("设为默认编辑服务")
      .addButton((button) =>
        button.setButtonText("设为默认").onClick(async () => {
          this.plugin.settings.defaultEditProviderId = provider.id;
          await this.plugin.saveSettings();
          new Notice(`已将 ${provider.name} 设为默认编辑服务。`);
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
    containerEl.createEl("h3", { text: "上下文范围" });

    new Setting(containerEl)
      .setName("激活范围")
      .setDesc("AI 只会读取当前激活范围内的 Markdown 文件。")
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
        })
      );

    if (scope.mode === "files") {
      this.renderListSetting(group, "文件路径", "每行一个 Markdown 文件路径，例如 Projects/Plan.md。", scope.files, async (value) => {
        scope.files = value;
        await this.plugin.saveSettings();
      });
    }

    if (scope.mode === "folders") {
      this.renderListSetting(group, "文件夹路径", "每行一个文件夹路径，例如 Projects。", scope.folders, async (value) => {
        scope.folders = value;
        await this.plugin.saveSettings();
      });
    }

    if (scope.mode === "tags") {
      this.renderListSetting(group, "标签", "每行一个标签，可以带 #，例如 #project。", scope.tags, async (value) => {
        scope.tags = value.map((tag) => tag.replace(/^#/, ""));
        await this.plugin.saveSettings();
      });
    }

    if (scope.mode === "rules") {
      this.renderListSetting(group, "路径包含规则", "每行一个路径关键词，文件路径包含任一规则即会纳入。", scope.pathRules, async (value) => {
        scope.pathRules = value;
        await this.plugin.saveSettings();
      });
    }

    if (scope.mode !== "current-file") {
      this.renderListSetting(group, "排除规则", "每行一个路径关键词，匹配后会从当前范围中排除。", scope.excludeRules, async (value) => {
        scope.excludeRules = value;
        await this.plugin.saveSettings();
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
    containerEl.createEl("h3", { text: "Prompt 模板" });
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
    onChange: (values: string[]) => Promise<void>
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.setValue(values.join("\n"));
        text.onChange(async (value) => {
          debouncedSave(() => onChange(parseList(value)));
        });
      });
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

function parseList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}
