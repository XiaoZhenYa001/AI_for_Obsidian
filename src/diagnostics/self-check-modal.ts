import { App, Modal, setIcon } from "obsidian";

export type SelfCheckItem = {
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

export class SelfCheckModal extends Modal {
  constructor(
    app: App,
    private items: SelfCheckItem[],
    private readonly onRefresh?: () => SelfCheckItem[]
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass("ai-second-brain-self-check-modal");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "AI Second Brain 自检" });
    contentEl.createEl("p", {
      cls: "ai-second-brain-muted",
      text: "这些检查用于确认插件基础状态。外部 API 连通性仍需通过实际发送请求验证。"
    });

    if (this.onRefresh) {
      const refreshButton = contentEl.createEl("button", {
        cls: "ai-second-brain-icon-button",
        attr: { type: "button", "aria-label": "刷新", title: "刷新" }
      });
      const refreshIcon = refreshButton.createSpan({ cls: "ai-second-brain-button-icon" });
      setIcon(refreshIcon, "refresh-cw");
      refreshButton.createSpan({ cls: "ai-second-brain-button-label", text: "刷新" });
      refreshButton.addEventListener("click", () => {
        this.items = this.onRefresh!();
        this.render();
      });
    }

    for (const item of this.items) {
      const row = contentEl.createDiv({
        cls: `ai-second-brain-self-check-item ai-second-brain-self-check-${item.status}`
      });
      row.createSpan({
        cls: "ai-second-brain-self-check-status",
        text: statusLabel(item.status)
      });
      const body = row.createDiv({ cls: "ai-second-brain-self-check-body" });
      body.createDiv({ cls: "ai-second-brain-self-check-label", text: item.label });
      body.createDiv({ cls: "ai-second-brain-self-check-detail", text: item.detail });
    }
  }
}

function statusLabel(status: SelfCheckItem["status"]): string {
  if (status === "pass") {
    return "通过";
  }

  if (status === "warn") {
    return "注意";
  }

  return "失败";
}
