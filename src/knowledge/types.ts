export type KnowledgeNote = {
  path: string;
  title: string;
  folder: string;
  tags: string[];
  outgoingLinks: string[];
  incomingLinks: string[];
  wordCount: number;
  modifiedTime: number;
  excerpt: string;
  hasFrontmatter: boolean;
  hasSummary: boolean;
};

export type TagStat = {
  tag: string;
  count: number;
};

export type LinkSuggestion = {
  sourcePath: string;
  targetPath: string;
  targetTitle: string;
  reason: string;
  score: number;
};

export type DuplicateGroup = {
  reason: string;
  notes: KnowledgeNote[];
};

export type KnowledgeHealthReport = {
  scopeName: string;
  generatedAt: string;
  notes: KnowledgeNote[];
  isolatedNotes: KnowledgeNote[];
  missingFrontmatter: KnowledgeNote[];
  missingSummary: KnowledgeNote[];
  duplicateGroups: DuplicateGroup[];
  linkSuggestions: LinkSuggestion[];
  tagStats: TagStat[];
};
