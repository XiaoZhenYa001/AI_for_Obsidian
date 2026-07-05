import { App, TFile } from "obsidian";
import { chunkMarkdown } from "./chunker";
import { NoteChunk, RetrievedChunk } from "./types";

const SCORE_DIRECT_PHRASE = 12;
const SCORE_PATH_MATCH = 4;
const SCORE_HEADING_MATCH = 3;
const SCORE_CONTENT_MAX = 5;

type IndexedFile = {
  path: string;
  mtime: number;
  size: number;
  chunks: NoteChunk[];
};

export type TextIndexStats = {
  indexedFiles: number;
  indexedChunks: number;
  lastRebuildAt?: string;
};

export class TextSearchService {
  private index = new Map<string, IndexedFile>();
  private lastRebuildAt?: string;

  constructor(private readonly app: App) {}

  async rebuild(files: TFile[]): Promise<TextIndexStats> {
    this.index.clear();

    for (const file of files) {
      await this.indexFile(file);
    }

    this.lastRebuildAt = new Date().toISOString();
    return this.getStats();
  }

  invalidateFile(path: string): void {
    this.index.delete(path);
  }

  clear(): void {
    this.index.clear();
    this.lastRebuildAt = undefined;
  }

  getStats(): TextIndexStats {
    let indexedChunks = 0;

    for (const file of this.index.values()) {
      indexedChunks += file.chunks.length;
    }

    return {
      indexedFiles: this.index.size,
      indexedChunks,
      lastRebuildAt: this.lastRebuildAt
    };
  }

  async search(query: string, files: TFile[], limit = 6): Promise<RetrievedChunk[]> {
    const terms = extractTerms(query);
    const directPhrase = normalize(query);
    const results: RetrievedChunk[] = [];
    const fallbackResults: RetrievedChunk[] = [];

    for (const file of files) {
      const indexedFile = await this.ensureIndexed(file);
      const chunks = indexedFile.chunks;

      if (files.length === 1) {
        fallbackResults.push(
          ...chunks.slice(0, limit).map((chunk) => ({
            ...chunk,
            score: 0.1
          }))
        );
      }

      for (const chunk of chunks) {
        const score = scoreChunk(chunk.filePath, chunk.heading || "", chunk.content, terms, directPhrase);

        if (score > 0) {
          results.push({
            ...chunk,
            score
          });
        }
      }
    }

    if (results.length > 0) {
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    return fallbackResults.slice(0, limit);
  }

  private async ensureIndexed(file: TFile): Promise<IndexedFile> {
    const existing = this.index.get(file.path);

    if (existing && existing.mtime === file.stat.mtime && existing.size === file.stat.size) {
      return existing;
    }

    return this.indexFile(file);
  }

  private async indexFile(file: TFile): Promise<IndexedFile> {
    const content = await this.app.vault.cachedRead(file);
    const indexedFile: IndexedFile = {
      path: file.path,
      mtime: file.stat.mtime,
      size: file.stat.size,
      chunks: chunkMarkdown(file.path, content)
    };

    this.index.set(file.path, indexedFile);
    return indexedFile;
  }
}

function scoreChunk(
  filePath: string,
  heading: string,
  content: string,
  terms: string[],
  directPhrase: string
): number {
  const normalizedPath = normalize(filePath);
  const normalizedHeading = normalize(heading);
  const normalizedContent = normalize(content);
  let score = 0;

  if (directPhrase.length >= 4 && normalizedContent.includes(directPhrase)) {
    score += SCORE_DIRECT_PHRASE;
  }

  for (const term of terms) {
    if (normalizedPath.includes(term)) {
      score += SCORE_PATH_MATCH;
    }

    if (normalizedHeading.includes(term)) {
      score += SCORE_HEADING_MATCH;
    }

    score += Math.min(countOccurrences(normalizedContent, term), SCORE_CONTENT_MAX);
  }

  return score;
}

function extractTerms(value: string): string[] {
  const normalized = normalize(value);
  const terms = new Set<string>();
  const latinTerms = normalized.match(/[a-z0-9_#/-]{2,}/g) || [];
  const cjkBlocks = normalized.match(/[\u3400-\u9fff\u{20000}-\u{2A6DF}\u3040-\u309F\u30A0-\u30FF]+/gu) || [];

  for (const term of latinTerms) {
    terms.add(term);
  }

  for (const block of cjkBlocks) {
    if (block.length <= 4) {
      terms.add(block);
      continue;
    }

    for (let index = 0; index < block.length - 1; index += 1) {
      terms.add(block.slice(index, index + 2));
    }

    for (let index = 0; index < block.length - 2; index += 1) {
      terms.add(block.slice(index, index + 3));
    }
  }

  return Array.from(terms).filter((term) => term.length > 1);
}

function countOccurrences(value: string, term: string): number {
  if (!term) {
    return 0;
  }

  let count = 0;
  let index = value.indexOf(term);

  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }

  return count;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}
