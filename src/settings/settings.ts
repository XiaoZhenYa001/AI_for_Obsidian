import { ContextScope } from "../context/scope-types";
import { StoredChatSession } from "../chat/types";
import { AIProviderConfig } from "../providers/types";
import { PromptTemplate } from "../templates/types";

export type ObsidianAISettings = {
  providers: AIProviderConfig[];
  defaultChatProviderId: string;
  defaultEditProviderId: string;
  activeContextScopeId: string;
  contextScopes: ContextScope[];
  promptTemplates: PromptTemplate[];
  chatSessions: StoredChatSession[];
  activeChatSessionId: string;
};
