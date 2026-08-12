import { setIcon } from "obsidian";
import { createMermaidMarkdown } from "../utils/mermaid";

export function extractMermaidSources(markdown: string): string[] {
  return Array.from(markdown.matchAll(/```mermaid\s*\r?\n([\s\S]*?)```/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

export function enhanceMermaidArtifacts(root: HTMLElement, sources: string[] = []): void {
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>(".mermaid"))
    .filter((element) => !element.closest(".ai-second-brain-mermaid-artifact"));

  diagrams.forEach((diagram, index) => {
    createMermaidArtifact(diagram, sources[index] || "");
  });
}

function createMermaidArtifact(diagram: HTMLElement, source: string): void {
  const parent = diagram.parentElement;
  if (!parent) {
    return;
  }

  const ownerDocument = diagram.ownerDocument;
  const artifact = ownerDocument.createElement("section");
  artifact.className = "ai-second-brain-mermaid-artifact";
  parent.insertBefore(artifact, diagram);

  const header = ownerDocument.createElement("header");
  header.className = "ai-second-brain-mermaid-header";
  artifact.appendChild(header);

  const identity = ownerDocument.createElement("div");
  identity.className = "ai-second-brain-mermaid-identity";
  header.appendChild(identity);
  const icon = ownerDocument.createElement("span");
  icon.className = "ai-second-brain-mermaid-icon";
  setIcon(icon, "workflow");
  identity.appendChild(icon);
  const title = ownerDocument.createElement("span");
  title.className = "ai-second-brain-mermaid-title";
  title.textContent = "Mermaid 图表";
  identity.appendChild(title);

  const controls = ownerDocument.createElement("div");
  controls.className = "ai-second-brain-mermaid-controls";
  header.appendChild(controls);

  const tabs = ownerDocument.createElement("div");
  tabs.className = "ai-second-brain-mermaid-tabs";
  tabs.setAttribute("role", "tablist");
  controls.appendChild(tabs);
  const previewButton = createTabButton(ownerDocument, "预览", true);
  tabs.appendChild(previewButton);
  const sourceButton = createTabButton(ownerDocument, "源代码", false);
  sourceButton.disabled = !source;
  tabs.appendChild(sourceButton);

  const copyButton = createIconButton(ownerDocument, "copy", "复制为 Mermaid Markdown");
  copyButton.disabled = !source;
  controls.appendChild(copyButton);
  const fullscreenButton = createIconButton(ownerDocument, "maximize-2", "全屏查看");
  controls.appendChild(fullscreenButton);

  const body = ownerDocument.createElement("div");
  body.className = "ai-second-brain-mermaid-body";
  artifact.appendChild(body);
  const preview = ownerDocument.createElement("div");
  preview.className = "ai-second-brain-mermaid-preview";
  preview.setAttribute("role", "tabpanel");
  body.appendChild(preview);
  preview.appendChild(diagram);

  const sourceView = ownerDocument.createElement("pre");
  sourceView.className = "ai-second-brain-mermaid-source";
  sourceView.setAttribute("role", "tabpanel");
  sourceView.hidden = true;
  const code = ownerDocument.createElement("code");
  code.textContent = source;
  sourceView.appendChild(code);
  body.appendChild(sourceView);

  const showPreview = (): void => {
    preview.hidden = false;
    sourceView.hidden = true;
    setTabState(previewButton, true);
    setTabState(sourceButton, false);
  };
  const showSource = (): void => {
    if (!source) {
      return;
    }
    preview.hidden = true;
    sourceView.hidden = false;
    setTabState(previewButton, false);
    setTabState(sourceButton, true);
  };

  previewButton.addEventListener("click", showPreview);
  sourceButton.addEventListener("click", showSource);
  copyButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(createMermaidMarkdown(source));
    setIcon(copyButton, "check");
    copyButton.title = "已复制";
    ownerDocument.defaultView?.setTimeout(() => {
      setIcon(copyButton, "copy");
      copyButton.title = "复制为 Mermaid Markdown";
      copyButton.setAttribute("aria-label", copyButton.title);
    }, 1200);
  });
  const setFullscreen = (fullscreen: boolean): void => {
    artifact.toggleClass("is-fullscreen", fullscreen);
    setIcon(fullscreenButton, artifact.hasClass("is-fullscreen") ? "minimize-2" : "maximize-2");
    fullscreenButton.title = artifact.hasClass("is-fullscreen") ? "退出全屏" : "全屏查看";
    fullscreenButton.setAttribute("aria-label", fullscreenButton.title);
    if (fullscreen) {
      ownerDocument.addEventListener("keydown", handleFullscreenKeydown);
    } else {
      ownerDocument.removeEventListener("keydown", handleFullscreenKeydown);
    }
  };
  const handleFullscreenKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      setFullscreen(false);
      fullscreenButton.focus();
    }
  };
  fullscreenButton.addEventListener("click", () => {
    setFullscreen(!artifact.hasClass("is-fullscreen"));
  });
}

function createTabButton(ownerDocument: Document, label: string, selected: boolean): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = "ai-second-brain-mermaid-tab";
  button.textContent = label;
  setTabState(button, selected);
  return button;
}

function setTabState(button: HTMLButtonElement, selected: boolean): void {
  button.toggleClass("is-active", selected);
  button.setAttribute("aria-selected", String(selected));
}

function createIconButton(ownerDocument: Document, iconName: string, label: string): HTMLButtonElement {
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = "ai-second-brain-mermaid-action";
  button.title = label;
  button.setAttribute("aria-label", label);
  setIcon(button, iconName);
  return button;
}
