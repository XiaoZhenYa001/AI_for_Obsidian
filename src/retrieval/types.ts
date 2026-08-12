export type NoteChunk = {
  id: string;
  filePath: string;
  heading?: string;
  headingPath?: string[];
  semanticContext?: string;
  content: string;
  startLine: number;
  endLine: number;
};

export type RetrievedChunk = NoteChunk & {
  score: number;
};

export type Citation = {
  filePath: string;
  title: string;
  excerpt: string;
  startLine: number;
  endLine: number;
  evidenceType?: "direct" | "related";
  sourceFingerprint?: string;
};
