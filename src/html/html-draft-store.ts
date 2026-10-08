type Draft = { base: string; text: string; updatedAt: number };
type Drafts = Record<string, Draft>;

/** Each open editor owns its entry; closing a clean second tab must not erase another tab's work. */
export class HtmlDraftStore {
  private readonly id = crypto.randomUUID();
  private recovered = new Map<string, { id: string; draft: Draft }>();
  constructor(private readonly read: (key: string) => unknown, private readonly write: (key: string, value: unknown) => void) {}

  private key(path: string): string { return `ai-second-brain:html-draft:${path}`; }

  private entries(path: string): Drafts {
    const stored = this.read(this.key(path)) as { drafts?: Drafts; base?: unknown; text?: unknown } | null;
    if (stored && typeof stored.base === "string" && typeof stored.text === "string") {
      return { legacy: { base: stored.base, text: stored.text, updatedAt: 0 } };
    }
    const entries: Drafts = {};
    for (const [id, draft] of Object.entries(stored?.drafts || {})) {
      if (draft && typeof draft.base === "string" && typeof draft.text === "string" && typeof draft.updatedAt === "number") entries[id] = draft;
    }
    return entries;
  }

  restore(path: string): Draft | undefined {
    const latest = Object.entries(this.entries(path)).sort((a, b) => b[1].updatedAt - a[1].updatedAt)[0];
    if (!latest) return undefined;
    this.recovered.set(path, { id: latest[0], draft: latest[1] });
    return latest[1];
  }

  persist(path: string, base: string, text: string): void {
    const entries = this.entries(path);
    const recovered = this.recovered.get(path);
    if (recovered) {
      const previous = entries[recovered.id];
      if (previous?.text === recovered.draft.text && previous.base === recovered.draft.base && previous.updatedAt === recovered.draft.updatedAt) delete entries[recovered.id];
      this.recovered.delete(path);
    }
    if (base !== text) entries[this.id] = { base, text, updatedAt: Date.now() };
    else delete entries[this.id];
    this.write(this.key(path), Object.keys(entries).length ? { drafts: entries } : null);
  }

  rename(oldPath: string, newPath: string, base: string, text: string): void {
    // Persist the new location first so a storage failure does not discard the old recovery entry.
    this.persist(newPath, base, text);
    this.persist(oldPath, base, base);
  }
}
