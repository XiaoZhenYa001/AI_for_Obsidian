function decorate() {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.empty = function(this: HTMLElement) { this.replaceChildren(); };
  proto.addClass = function(this: HTMLElement, ...names: string[]) { this.classList.add(...names); };
  proto.removeClass = function(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); };
  proto.hasClass = function(this: HTMLElement, name: string) { return this.classList.contains(name); };
  proto.toggleClass = function(this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); };
  proto.setText = function(this: HTMLElement, text: string) { this.textContent = text; };
  proto.createEl = function(this: HTMLElement, tag: string, options: Record<string, any> = {}) {
    const element = document.createElement(tag);
    if (options.text) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    if (options.type) element.setAttribute("type", options.type);
    for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, String(value));
    this.appendChild(element);
    return element;
  };
  proto.createDiv = function(this: any, options: any) { return this.createEl("div", typeof options === "string" ? { cls: options } : options); };
  proto.createSpan = function(this: any, options: any) { return this.createEl("span", typeof options === "string" ? { cls: options } : options); };
}
decorate();

export class Component {
  disposers: Array<() => void> = [];
  register(callback: () => void) { this.disposers.push(callback); }
  registerEvent(ref: any) { if (typeof ref === "function") this.register(ref); }
  registerDomEvent(el: EventTarget, event: string, callback: EventListener) { el.addEventListener(event, callback); this.register(() => el.removeEventListener(event, callback)); }
  addChild(child: any) { return child; }
  removeChild(child: any) { child.unload?.(); }
  unload() { this.disposers.forEach(fn => fn()); }
}
export class TFile {
  path: string; extension: string; name: string; basename: string;
  stat = { size: 1, mtime: 1, ctime: 1 };
  constructor(path: string) { this.path = path; this.name = path.split("/").pop()!; this.extension = path.split(".").pop()!; this.basename = this.name.replace(/\.[^.]+$/, ""); }
}
export class TFolder {}
export class FileSystemAdapter { getBasePath() { return "fixture-vault"; } }
export class ItemView extends Component {
  app: any; containerEl: HTMLElement; contentEl: HTMLElement;
  constructor(public leaf: any) {
    super(); this.app = leaf.app;
    this.app.loadLocalStorage ??= (key: string) => JSON.parse(localStorage.getItem(key) || "null");
    this.app.saveLocalStorage ??= (key: string, value: unknown) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value));
    this.containerEl = document.createElement("section");
    this.containerEl.className = "fixture-view";
    this.containerEl.append(document.createElement("header"));
    this.contentEl = document.createElement("div");
    this.containerEl.append(this.contentEl); document.body.append(this.containerEl);
  }
}
export class FileView extends ItemView { file: TFile | null = null; }
export class MarkdownView extends FileView {}
export class Modal extends Component {
  modalEl: HTMLElement; contentEl: HTMLElement;
  constructor(public app: any) {
    super(); this.modalEl = document.createElement("section"); this.modalEl.className = "modal";
    this.contentEl = document.createElement("div"); this.contentEl.className = "modal-content";
    this.modalEl.append(this.contentEl);
  }
  open() { document.body.append(this.modalEl); (this as any).onOpen?.(); }
  close() { (this as any).onClose?.(); this.modalEl.remove(); this.unload(); }
}
export class Notice {
  constructor(message: string) { const notice = document.createElement("div"); notice.className = "notice"; notice.textContent = message; document.body.append(notice); }
}
export class FuzzySuggestModal<T> extends Modal {
  private placeholder = "";
  setPlaceholder(value: string) { this.placeholder = value; }
  getItems(): T[] { return []; }
  getItemText(item: T): string { return String(item); }
  onChooseItem(_item: T): void {}
  onClose(): void {}
  onOpen() {
    const input = this.contentEl.createEl("input", { attr: { placeholder: this.placeholder, "aria-label": this.placeholder } });
    const list = this.contentEl.createDiv();
    const render = () => {
      list.empty();
      this.getItems().filter(item => this.getItemText(item).includes(input.value)).forEach(item => {
        list.createEl("button", { text: this.getItemText(item) }).addEventListener("click", () => { this.close(); this.onChooseItem(item); });
      });
    };
    input.addEventListener("input", render); render();
  }
}
export class Menu {
  private items: Array<{ title: string; click: () => void }> = [];
  addSeparator() { return this; }
  addItem(callback: (item: any) => void) {
    const entry = { title: "", click() {} };
    const item: any = { setTitle(value: string) { entry.title = value; return item; }, setIcon() { return item; }, setChecked() { return item; }, onClick(fn: () => void) { entry.click = fn; return item; } };
    callback(item); this.items.push(entry); return this;
  }
  showAtMouseEvent() {
    const menu = document.body.createDiv({ cls: "fixture-menu" });
    this.items.forEach(item => menu.createEl("button", { text: item.title }).addEventListener("click", () => { menu.remove(); item.click(); }));
  }
}
export const MarkdownRenderer = { async render(_app: any, source: string, element: HTMLElement) { element.setText(source); } };
export class Setting {
  controlEl: HTMLElement;
  constructor(container: HTMLElement) {
    const row = document.createElement("div"); row.className = "setting-item"; container.append(row);
    this.controlEl = document.createElement("div"); this.controlEl.className = "setting-item-control"; row.append(this.controlEl);
  }
  setName(value: string) { this.controlEl.parentElement!.prepend(Object.assign(document.createElement("label"), { textContent: value })); return this; }
  setDesc(value: string) { this.controlEl.parentElement!.title = value; return this; }
  addDropdown(fn: (control: any) => void) {
    const el = document.createElement("select"); this.controlEl.append(el);
    const control = {
      selectEl: el,
      addOption(value: string, label: string) { el.add(new Option(label, value)); return control; },
      setValue(value: string) { el.value = value; return control; },
      onChange(callback: (value: string) => void) { el.addEventListener("change", () => callback(el.value)); return control; }
    }; fn(control); return this;
  }
  addText(fn: (control: any) => void) { return this.addInput("input", fn); }
  addTextArea(fn: (control: any) => void) { return this.addInput("textarea", fn); }
  private addInput(tag: "input" | "textarea", fn: (control: any) => void) {
    const el = document.createElement(tag); this.controlEl.append(el);
    const control = {
      inputEl: el,
      setValue(value: string) { el.value = value; return control; },
      setPlaceholder(value: string) { el.placeholder = value; return control; },
      onChange(callback: (value: string) => void) { el.addEventListener("input", () => callback(el.value)); return control; }
    }; fn(control); return this;
  }
}
export function setIcon(el: HTMLElement, name: string) { el.setAttribute("data-icon", name); }
export function normalizePath(path: string) { return path.replace(/\\/g, "/").replace(/\/+/g, "/"); }
