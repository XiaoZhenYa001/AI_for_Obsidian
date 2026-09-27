export type ModificationOperation = "update" | "create" | "rename" | "delete";

export type ModificationPlanItem = {
  id: string;
  operation: ModificationOperation;
  path: string;
  targetPath?: string;
  summary: string;
  proposedContent?: string;
  edits?: Array<{ oldText: string; newText: string }>;
  originalContent?: string;
};

export type ModificationPlan = {
  title: string;
  rationale: string;
  items: ModificationPlanItem[];
};

export type ModificationSnapshotEntry = {
  operation: ModificationOperation;
  path: string;
  targetPath?: string;
  originalContent?: string;
  appliedContent?: string;
};

export type ModificationSnapshot = {
  createdAt: string;
  entries: ModificationSnapshotEntry[];
  /** Keep an incomplete rollback or undo until the remaining entries are restored. */
  recoveryPending?: boolean;
};
