import { createExcerpt } from "../utils/text";
import { Citation, RetrievedChunk } from "./types";

export function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const chunk of chunks) {
    const key = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    citations.push({
      filePath: chunk.filePath,
      title: chunk.heading || chunk.filePath.split("/").pop() || chunk.filePath,
      excerpt: createExcerpt(chunk.content),
      startLine: chunk.startLine,
      endLine: chunk.endLine
    });
  }

  return citations;
}
