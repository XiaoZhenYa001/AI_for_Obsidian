import { IconName, setIcon } from "obsidian";

export function createIconButton(container: HTMLElement, icon: IconName, text: string, className = ""): HTMLButtonElement {
  const button = container.createEl("button", {
    cls: ["ai-second-brain-icon-button", className].filter(Boolean).join(" "),
    attr: {
      "aria-label": text,
      title: text
    }
  });
  const iconEl = button.createSpan({ cls: "ai-second-brain-button-icon" });
  setIcon(iconEl, icon);
  button.createSpan({ cls: "ai-second-brain-button-label", text });
  return button;
}
