/** The disk baseline is kept separately from the draft so external writes never overwrite edits. */
export class HtmlSourceSession {
  base = "";
  text = "";
  conflict = false;

  get dirty(): boolean { return this.text !== this.base; }

  load(source: string, draft?: { base: string; text: string }): void {
    this.base = draft?.base ?? source;
    this.text = draft?.text ?? source;
    this.conflict = this.dirty && source !== this.base && source !== this.text;
    if (source === this.text) this.base = source;
  }

  receive(source: string): void {
    if (!this.dirty) this.load(source);
    else if (source === this.text) this.load(source);
    else this.conflict = source !== this.base;
  }

  async save(process: (update: (current: string) => string) => Promise<string>): Promise<void> {
    const base = this.base;
    const text = this.text;
    await process(current => {
      if (current !== base && current !== text) {
        this.conflict = true;
        throw new Error("文件已被其他窗口修改，未覆盖文件。请另存副本，或放弃修改后重新载入。");
      }
      return text;
    });
    this.base = text;
    this.conflict = false;
  }
}
