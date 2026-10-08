import { Citation } from "../retrieval/types";
import { ContextScope } from "../context/scope-types";

export type ChatContextMode = "follow" | "locked" | "manual";

export type SelectionReference = {
  id: string;
  filePath: string;
  fileName: string;
  fromLine: number;
  fromCh: number;
  toLine: number;
  toCh: number;
  text: string;
};

export type StoredChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  selectionReferences?: SelectionReference[];
  createdAt: string;
  status?: "complete" | "error" | "stopped";
  drawing?: { path: string; state: "preview" | "applied" | "discarded" | "expired" | "undone" };
};

export type StoredChatSession = {
  id: string;
  title: string;
  contextScopeId: string;
  contextScopeOverride?: ContextScope;
  contextMode: ChatContextMode;
  contextFilePath: string;
  purpose: string;
  autoContext: boolean;
  lockedFilePaths: string[];
  lastContextFilePaths: string[];
  lastContextFingerprint: string;
  messages: StoredChatMessage[];
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
};

export type ChatSessionConfig = Pick<
  StoredChatSession,
  "title" | "contextScopeId" | "contextMode" | "purpose" | "autoContext" | "lockedFilePaths"
>;

export type ViewChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  selectionReferences?: SelectionReference[];
  isComplete: boolean;
  status: "streaming" | "complete" | "error" | "stopped";
  createdAt?: string;
  drawing?: StoredChatMessage["drawing"];
};
