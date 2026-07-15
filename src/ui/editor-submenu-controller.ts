import { Editor, Menu } from "obsidian";
import type ObsidianAIPlugin from "../main";
import { runSelectionAction } from "../actions/selection-actions";
import { GenerateContentModal } from "../actions/generate-content-modal";
import { GenerateDiagramModal } from "../diagrams/generate-diagram-modal";

const SUBMENU_CLOSE_DELAY_MS = 180;
const SUBMENU_OFFSET_PX = 8;

export class EditorSubmenuController {
  private submenu?: Menu;
  private submenuAnchor?: HTMLElement;
  private closeTimer?: number;

  constructor(private readonly plugin: ObsidianAIPlugin) {}

  createMenuTitle(editor: Editor): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const title = document.createElement("span");
    title.className = "ai-second-brain-editor-menu-parent";

    const label = document.createElement("span");
    label.textContent = "AI 询问";
    title.appendChild(label);

    const arrow = document.createElement("span");
    arrow.className = "ai-second-brain-editor-menu-arrow";
    arrow.textContent = "›";
    title.appendChild(arrow);

    let menuItemEl: HTMLElement | null = null;
    const openSubmenu = () => {
      this.clearCloseTimer();
      this.openAtElement(menuItemEl || title, editor);
    };
    const bindParentHover = () => {
      menuItemEl = title.closest(".menu-item") as HTMLElement | null;
      menuItemEl?.addEventListener("mouseenter", openSubmenu);
      menuItemEl?.addEventListener("mouseleave", () => {
        this.scheduleClose();
      });
    };

    title.addEventListener("mouseenter", openSubmenu);
    title.addEventListener("focus", openSubmenu);
    title.addEventListener("blur", () => {
      this.scheduleClose();
    });
    requestAnimationFrame(bindParentHover);

    fragment.appendChild(title);
    return fragment;
  }

  hide(): void {
    this.clearCloseTimer();
    this.submenu?.hide();
    this.submenu = undefined;
    this.submenuAnchor = undefined;
  }

  private openAtElement(anchorEl: HTMLElement, editor: Editor): void {
    this.clearCloseTimer();

    if (this.submenu && this.submenuAnchor === anchorEl) {
      return;
    }

    this.submenu?.hide();

    const rect = anchorEl.getBoundingClientRect();
    const submenu = this.createSubmenu(editor);
    this.submenuAnchor = anchorEl;
    this.submenu = submenu;
    submenu.onHide(() => {
      if (this.submenu === submenu) {
        this.submenu = undefined;
        this.submenuAnchor = undefined;
      }
    });
    submenu.showAtPosition({
      x: rect.right + SUBMENU_OFFSET_PX,
      y: rect.top,
      overlap: true
    });
    requestAnimationFrame(() => {
      this.bindSubmenuHover(submenu);
    });
  }

  private bindSubmenuHover(submenu: Menu): void {
    if (this.submenu !== submenu) {
      return;
    }

    const menus = Array.from(document.querySelectorAll<HTMLElement>(".menu"));
    const submenuEl = menus[menus.length - 1];

    if (!submenuEl) {
      return;
    }

    submenuEl.classList.add("ai-second-brain-editor-submenu");
    submenuEl.addEventListener("mouseenter", () => {
      this.clearCloseTimer();
    });
    submenuEl.addEventListener("mouseleave", () => {
      this.scheduleClose();
    });
  }

  private scheduleClose(): void {
    this.clearCloseTimer();
    this.closeTimer = window.setTimeout(() => {
      this.hide();
    }, SUBMENU_CLOSE_DELAY_MS);
  }

  private clearCloseTimer(): void {
    if (this.closeTimer === undefined) {
      return;
    }

    window.clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
  }

  private createSubmenu(editor: Editor): Menu {
    const submenu = new Menu();

    submenu.addItem((item) =>
      item.setTitle("解释").setIcon("message-circle-question").onClick(() => {
        void runSelectionAction(this.plugin, editor, "explain");
      })
    );
    submenu.addItem((item) =>
      item.setTitle("总结").setIcon("list-checks").onClick(() => {
        void runSelectionAction(this.plugin, editor, "summarize");
      })
    );
    submenu.addItem((item) =>
      item.setTitle("改写").setIcon("wand-sparkles").onClick(() => {
        void runSelectionAction(this.plugin, editor, "rewrite");
      })
    );
    submenu.addItem((item) =>
      item.setTitle("翻译").setIcon("languages").onClick(() => {
        void runSelectionAction(this.plugin, editor, "translate");
      })
    );
    submenu.addItem((item) =>
      item.setTitle("扩写").setIcon("text-cursor-input").onClick(() => {
        void runSelectionAction(this.plugin, editor, "expand");
      })
    );
    submenu.addItem((item) =>
      item.setTitle("缩写").setIcon("minimize-2").onClick(() => {
        void runSelectionAction(this.plugin, editor, "condense");
      })
    );
    submenu.addSeparator();
    submenu.addItem((item) =>
      item.setTitle("生成内容").setIcon("file-plus-2").onClick(() => {
        new GenerateContentModal(this.plugin.app, this.plugin, editor).open();
      })
    );
    submenu.addItem((item) =>
      item.setTitle("生成图谱").setIcon("workflow").onClick(() => {
        const view = this.plugin.getEditableMarkdownView();
        const sourceFile = view?.editor === editor ? view.file || undefined : undefined;
        new GenerateDiagramModal(this.plugin.app, this.plugin, editor, sourceFile).open();
      })
    );

    return submenu;
  }
}
