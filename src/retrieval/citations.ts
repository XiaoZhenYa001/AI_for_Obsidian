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
      endLine: chunk.endLine,
      evidenceType: chunk.score >= 3 ? "direct" : "related",
      sourceFingerprint: createCitationFingerprint(chunk.content)
    });
  }

  return citations;
}

export function createCitationFingerprint(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
