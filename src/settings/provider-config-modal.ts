import { App, Modal, Notice, setIcon, Setting } from "obsidian";
import { AIProviderConfig, AIProviderType } from "../providers/types";
import { createIconButton } from "../ui/icon-button";

type ProviderDefaults = Pick<AIProviderConfig, "name" | "baseUrl" | "defaultModel">;

const PROVIDER_DEFAULTS: Record<AIProviderType, ProviderDefaults> = {
  "openai-compatible": {
    name: "OpenAI-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: ""
  },
  anthropic: {
    name: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: ""
  },
  ollama: {
    name: "Ollama",
    baseUrl: "http://localhost:11434",
    defaultModel: ""
  }
};

export function configureProvider(app: App): Promise<AIProviderConfig | undefined> {
  return new Promise((resolve) => {
    new ProviderConfigModal(app, resolve).open();
  });
}

class ProviderConfigModal extends Modal {
  private type: AIProviderType = "openai-compatible";
  private name = PROVIDER_DEFAULTS[this.type].name;
  private baseUrl = PROVIDER_DEFAULTS[this.type].baseUrl || "";
  private apiKey = "";
  private model = "";
  private temperature = 0.7;
  private stream = true;
  private settled = false;

  constructor(
    app: App,
    private readonly resolveResult: (result: AIProviderConfig | undefined) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass("ai-second-brain-provider-modal");
    this.modalEl.addClass("ai-second-brain-provider-modal-shell");
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
    const { contentEl } = this;
    contentEl.empty();

    const header = contentEl.createDiv({ cls: "ai-second-brain-modal-header" });
    const icon = header.createDiv({ cls: "ai-second-brain-modal-icon" });
    setIcon(icon, "server-cog");
    const heading = header.createDiv({ cls: "ai-second-brain-modal-heading" });
    heading.createEl("h2", { text: "添加 AI 服务商" });
    heading.createEl("p", {
      cls: "ai-second-brain-muted",
      text: "每套配置独立保存，可为同一协议添加多个 API。"
    });

    const form = contentEl.createDiv({ cls: "ai-second-brain-provider-form" });
    new Setting(form)
      .setName("接口协议")
      .setDesc(providerTypeDescription(this.type))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("openai-compatible", "OpenAI-compatible")
          .addOption("anthropic", "Anthropic Messages")
          .addOption("ollama", "Ollama")
          .setValue(this.type)
          .onChange((value) => {
            this.type = value as AIProviderType;
            const defaults = PROVIDER_DEFAULTS[this.type];
            this.name = defaults.name;
            this.baseUrl = defaults.baseUrl || "";
            this.model = defaults.defaultModel;
            if (this.type === "ollama") {
              this.apiKey = "";
            }
            this.render();
          });
      });

    new Setting(form)
      .setName("显示名称")
      .setDesc("用于对话、任务路由和状态提示。")
      .addText((text) =>
        text
          .setPlaceholder("例如：DeepSeek 日常问答")
          .setValue(this.name)
          .onChange((value) => {
            this.name = value;
          })
      );

    new Setting(form)
      .setName("Base URL")
      .setDesc("填写服务商 API 根地址，不包含具体模型名称。")
      .addText((text) =>
        text
          .setPlaceholder(PROVIDER_DEFAULTS[this.type].baseUrl || "https://example.com/v1")
          .setValue(this.baseUrl)
          .onChange((value) => {
            this.baseUrl = value;
          })
      );

    new Setting(form)
      .setName("API Key")
      .setDesc(
        this.type === "ollama"
          ? "本地 Ollama 通常可以留空。"
          : this.type === "openai-compatible"
            ? "保存在当前 Vault 的插件数据中；自建兼容接口可以留空。"
            : "保存在当前 Vault 的插件数据中。"
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(this.type === "ollama" ? "可留空" : "输入 API Key")
          .setValue(this.apiKey)
          .onChange((value) => {
            this.apiKey = value;
          });
      });

    new Setting(form)
      .setName("默认模型")
      .setDesc("必须与该服务商实际提供的模型标识一致。")
      .addText((text) =>
        text
          .setPlaceholder("输入模型标识")
          .setValue(this.model)
          .onChange((value) => {
            this.model = value;
          })
      );

    new Setting(form)
      .setName("流式输出")
      .setDesc("支持时逐步显示回答。")
      .addToggle((toggle) =>
        toggle.setValue(this.stream).onChange((value) => {
          this.stream = value;
        })
      );

    const actions = contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancelButton = createIconButton(actions, "x", "取消");
    cancelButton.addEventListener("click", () => this.close());
    const createButton = createIconButton(actions, "plus", "添加服务商", "mod-cta");
    createButton.addEventListener("click", () => this.submit());
  }

  private submit(): void {
    const name = this.name.trim();
    const baseUrl = this.baseUrl.trim().replace(/\/+$/, "");
    const model = this.model.trim();

    if (!name) {
      new Notice("请填写服务商名称。");
      return;
    }

    if (!baseUrl) {
      new Notice("请填写 Base URL。");
      return;
    }

    if (!model) {
      new Notice("请填写默认模型。");
      return;
    }

    if (this.type === "anthropic" && !this.apiKey.trim()) {
      new Notice("请填写 API Key。");
      return;
    }

    this.settled = true;
    this.resolveResult({
      id: `${this.type}-${crypto.randomUUID()}`,
      name,
      type: this.type,
      baseUrl,
      apiKey: this.apiKey.trim(),
      defaultModel: model,
      temperature: this.temperature,
      stream: this.stream,
      enabled: true
    });
    this.close();
  }
}

function providerTypeDescription(type: AIProviderType): string {
  if (type === "openai-compatible") {
    return "适用于 OpenAI、DeepSeek 及兼容 /chat/completions 的服务。";
  }

  if (type === "anthropic") {
    return "适用于 Anthropic Messages API。";
  }

  return "适用于本机或局域网中的 Ollama 服务。";
}
