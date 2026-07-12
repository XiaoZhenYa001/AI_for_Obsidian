import { Citation } from "../retrieval/types";

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
  messages: StoredChatMessage[];
  createdAt: string;
  updatedAt: string;
};

export type ViewChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  isComplete: boolean;
  status: "streaming" | "complete" | "error" | "stopped";
  createdAt?: string;
};
