import { App, Modal } from "obsidian";
import { createIconButton } from "./icon-button";

export function confirmAction(app: App, title: string, description: string, confirmLabel: string): Promise<boolean> {
  return new Promise(resolve => new ConfirmModal(app, title, description, confirmLabel, resolve).open());
}

class ConfirmModal extends Modal {
  private settled = false;

  constructor(app: App, private readonly heading: string, private readonly description: string,
    private readonly confirmLabel: string, private readonly resolveResult: (confirmed: boolean) => void) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.heading });
    this.contentEl.createEl("p", { text: this.description });
    const actions = this.contentEl.createDiv({ cls: "ai-second-brain-modal-actions" });
    const cancel = createIconButton(actions, "x", "取消");
    cancel.addEventListener("click", () => this.close());
    const confirm = createIconButton(actions, "trash-2", this.confirmLabel, "mod-warning");
    confirm.addEventListener("click", () => {
      this.settled = true;
      this.resolveResult(true);
      this.close();
    });
    cancel.focus();
  }

  onClose(): void {
    if (!this.settled) this.resolveResult(false);
    this.settled = true;
    this.contentEl.empty();
  }
}
