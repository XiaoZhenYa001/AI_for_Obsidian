import { ObsidianAISettings } from "./settings";
import { BUILT_IN_PROMPT_TEMPLATES } from "../templates/built-in-templates";

export const DEFAULT_SETTINGS: ObsidianAISettings = {
  providers: [],
  defaultChatProviderId: "",
  defaultEditProviderId: "",
  activeContextScopeId: "current-file",
  promptTemplates: BUILT_IN_PROMPT_TEMPLATES.map((t) => ({ ...t })),
  chatSessions: [],
  activeChatSessionId: "",
  diagramFolder: "AI Second Brain/Diagrams",
  diagramMaxNodes: 24,
  diagramAutoEmbed: true,
  contextScopes: [
    {
      id: "current-file",
      name: "当前文件",
      mode: "current-file",
      files: [],
      folders: [],
      tags: [],
      pathRules: [],
      excludeRules: [],
      allowCloudModels: true
    }
  ]
};
