import { PromptTemplate, PromptTemplateRenderInput, PromptTemplateTask } from "./types";

export class TemplateService {
  constructor(private templates: PromptTemplate[]) {}

  update(templates: PromptTemplate[]): void {
    this.templates = templates;
  }

  findByTask(task: PromptTemplateTask): PromptTemplate | undefined {
    for (let i = this.templates.length - 1; i >= 0; i--) {
      if (this.templates[i].task === task) {
        return this.templates[i];
      }
    }
    return undefined;
  }

  render(template: PromptTemplate, input: PromptTemplateRenderInput): string {
    const values: Record<string, string> = {
      selection: input.selection,
      noteTitle: input.noteTitle || "",
      filePath: input.filePath || ""
    };

    return template.prompt.replace(/\{\{\s*(selection|noteTitle|filePath)\s*\}\}/g, (_, key: string) => values[key] || "");
  }
}
