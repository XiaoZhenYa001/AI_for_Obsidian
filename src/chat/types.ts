import { Citation } from "../retrieval/types";
import { ContextScope } from "../context/scope-types";

export type StoredChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  createdAt: string;
};

export type StoredChatSession = {
  id: string;
  title: string;
  contextScopeId: string;
  contextScopeOverride?: ContextScope;
  purpose: string;
  autoContext: boolean;
  lockedFilePaths: string[];
  lastContextFilePaths: string[];
  messages: StoredChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type ChatSessionConfig = Pick<
  StoredChatSession,
  "title" | "contextScopeId" | "purpose" | "autoContext" | "lockedFilePaths"
>;

export type ViewChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  isComplete: boolean;
  status: "streaming" | "complete" | "error" | "stopped";
  createdAt?: string;
};
