import { ContextScope } from "../context/scope-types";
import { StoredChatMessage } from "../chat/types";
import { AIProviderConfig } from "../providers/types";
import { PromptTemplate } from "../templates/types";

export type ObsidianAISettings = {
  providers: AIProviderConfig[];
  defaultChatProviderId: string;
  defaultEditProviderId: string;
  activeContextScopeId: string;
  contextScopes: ContextScope[];
  promptTemplates: PromptTemplate[];
  chatHistory: StoredChatMessage[];
};
