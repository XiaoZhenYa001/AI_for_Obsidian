import { App, TFile } from "obsidian";
import { chunkMarkdown } from "./chunker";
import { prepareContextDocument } from "./markdown-semantics";
import { NoteChunk, RetrievedChunk } from "./types";

const SCORE_DIRECT_PHRASE = 12;
const SCORE_PATH_MATCH = 4;
const SCORE_HEADING_MATCH = 3;
const SCORE_CONTENT_MAX = 5;
const MAX_CANDIDATE_CHUNKS = 1600;
const INDEX_BATCH_SIZE = 8;
const INDEX_WORK_BUDGET_MS = 8;

type IndexedFile = {
  path: string;
  mtime: number;
  size: number;
  chunks: NoteChunk[];
  termChunkIds: Map<string, Set<string>>;
};

type PendingIndex = {
  path: string;
  mtime: number;
  size: number;
  promise: Promise<IndexedFile | undefined>;
};

export type TextIndexStats = {
  indexedFiles: number;
  indexedChunks: number;
  lastRebuildAt?: string;
};

export type RelevantFile = {
  filePath: string;
  score: number;
  matchedChunks: number;
};

export class TextSearchService {
  private index = new Map<string, IndexedFile>();
  private chunksById = new Map<string, NoteChunk>();
  private postings = new Map<string, Set<string>>();
  private pendingIndexes = new Map<string, PendingIndex>();
  private indexGeneration = 0;
  private incomingLinksByTarget?: Map<string, string[]>;
  private lastRebuildAt?: string;

  constructor(private readonly app: App) {}

  async rebuild(files: TFile[]): Promise<TextIndexStats> {
    this.clear();
    const generation = this.indexGeneration;

    await this.ensureFilesIndexed(files);

    if (generation === this.indexGeneration) this.lastRebuildAt = new Date().toISOString();
    return this.getStats();
  }

  invalidateFile(path: string): void {
    this.pendingIndexes.delete(path);
    this.removeIndexedFile(path);
    this.invalidateLinks();
  }

  invalidateLinks(): void {
    this.incomingLinksByTarget = undefined;
  }

  clear(): void {
    this.indexGeneration += 1;
    this.pendingIndexes.clear();
    this.index.clear();
    this.chunksById.clear();
    this.postings.clear();
    this.invalidateLinks();
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
    const allowedPaths = new Set(files.map((file) => file.path));

    await this.ensureFilesIndexed(files);
    if (files.length === 1) {
      const indexedFile = this.index.get(files[0].path);
      if (indexedFile) {
        fallbackResults.push(
          ...indexedFile.chunks.slice(0, limit).map((chunk) => ({
            ...chunk,
            incomingLinks: this.getAuthorizedIncomingLinks(chunk.filePath, allowedPaths),
            score: 0.1
          }))
        );
      }
    }

    const candidateHits = new Map<string, number>();
    for (const term of terms) {
      for (const chunkId of this.postings.get(term) || []) {
        const chunk = this.chunksById.get(chunkId);
        if (!chunk || !allowedPaths.has(chunk.filePath)) {
          continue;
        }
        candidateHits.set(chunkId, (candidateHits.get(chunkId) || 0) + 1);
      }
    }

    const candidateIds = Array.from(candidateHits.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CANDIDATE_CHUNKS)
      .map(([chunkId]) => chunkId);
    for (const chunkId of candidateIds) {
      const chunk = this.chunksById.get(chunkId);
      if (!chunk || !allowedPaths.has(chunk.filePath)) {
        continue;
      }

      const score = scoreChunk(
        chunk.filePath,
        chunk.heading || "",
        chunk.content,
        chunk.semanticContext || "",
        terms,
        directPhrase
      );

      if (score > 0) {
        results.push({
          ...chunk,
          incomingLinks: this.getAuthorizedIncomingLinks(chunk.filePath, allowedPaths),
          score
        });
      }
    }

    if (results.length > 0) {
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    return fallbackResults.slice(0, limit);
  }

  async rankFiles(query: string, files: TFile[], limit = 6): Promise<RelevantFile[]> {
    const chunks = await this.search(query, files, Math.max(limit * 6, 36));
    const ranked = new Map<string, RelevantFile>();

    for (const chunk of chunks) {
      const current = ranked.get(chunk.filePath);

      if (current) {
        current.score += chunk.score;
        current.matchedChunks += 1;
      } else {
        ranked.set(chunk.filePath, {
          filePath: chunk.filePath,
          score: chunk.score,
          matchedChunks: 1
        });
      }
    }

    return Array.from(ranked.values())
      .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
      .slice(0, limit);
  }

  async getRepresentativeChunks(
    files: TFile[],
    limitPerFile = 1,
    authorizedPaths: ReadonlySet<string> = new Set(files.map((file) => file.path))
  ): Promise<RetrievedChunk[]> {
    const results: RetrievedChunk[] = [];
    await this.ensureFilesIndexed(files);

    for (const file of files) {
      const indexedFile = this.index.get(file.path);
      if (!indexedFile) continue;
      results.push(
        ...indexedFile.chunks.slice(0, limitPerFile).map((chunk) => ({
          ...chunk,
          incomingLinks: this.getAuthorizedIncomingLinks(chunk.filePath, authorizedPaths),
          score: 0.05
        }))
      );
    }

    return results;
  }

  private async ensureIndexed(file: TFile): Promise<IndexedFile | undefined> {
    const existing = this.index.get(file.path);

    if (existing && existing.mtime === file.stat.mtime && existing.size === file.stat.size) {
      return existing;
    }

    const pending = this.pendingIndexes.get(file.path);
    if (pending && pending.mtime === file.stat.mtime && pending.size === file.stat.size) {
      return pending.promise;
    }

    const task: PendingIndex = {
      path: file.path,
      mtime: file.stat.mtime,
      size: file.stat.size,
      promise: Promise.resolve(undefined)
    };
    this.pendingIndexes.set(task.path, task);
    task.promise = this.indexFile(file, task).finally(() => {
      if (this.pendingIndexes.get(task.path) === task) this.pendingIndexes.delete(task.path);
    });
    return task.promise;
  }

  private async ensureFilesIndexed(files: TFile[]): Promise<void> {
    const generation = this.indexGeneration;
    let yieldedAt = performance.now();
    for (let index = 0; index < files.length; index += INDEX_BATCH_SIZE) {
      if (generation !== this.indexGeneration) return;
      const batch = files.slice(index, index + INDEX_BATCH_SIZE);
      await Promise.all(batch.map((file) => this.ensureIndexed(file)));
      if (index + INDEX_BATCH_SIZE < files.length && performance.now() - yieldedAt >= INDEX_WORK_BUDGET_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yieldedAt = performance.now();
      }
    }
  }

  private async indexFile(file: TFile, task: PendingIndex): Promise<IndexedFile | undefined> {
    this.removeIndexedFile(task.path);
    const rawContent = await this.app.vault.cachedRead(file);
    if (!this.isCurrentIndexTask(file, task)) return undefined;
    const prepared = prepareContextDocument(task.path, rawContent);
    const chunks = chunkMarkdown(task.path, prepared.content, undefined, prepared.semanticContext);
    const termChunkIds = new Map<string, Set<string>>();
    let yieldedAt = performance.now();
    let processed = 0;
    for (const chunk of chunks) {
      for (const term of extractIndexTerms(`${chunk.filePath}\n${chunk.heading || ""}\n${chunk.semanticContext || ""}\n${chunk.content}`)) {
        const fileIds = termChunkIds.get(term) || new Set<string>();
        fileIds.add(chunk.id);
        termChunkIds.set(term, fileIds);
      }
      if (++processed % 32 === 0 && performance.now() - yieldedAt >= INDEX_WORK_BUDGET_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!this.isCurrentIndexTask(file, task)) return undefined;
        yieldedAt = performance.now();
      }
    }
    // Publish together only while this read still belongs to the current file version.
    if (!this.isCurrentIndexTask(file, task)) return undefined;
    this.removeIndexedFile(task.path);
    for (const chunk of chunks) this.chunksById.set(chunk.id, chunk);
    for (const [term, fileIds] of termChunkIds) {
      const ids = this.postings.get(term) || new Set<string>();
      for (const id of fileIds) ids.add(id);
      this.postings.set(term, ids);
    }
    const indexedFile: IndexedFile = {
      path: task.path,
      mtime: task.mtime,
      size: task.size,
      chunks,
      termChunkIds
    };

    this.index.set(task.path, indexedFile);
    return indexedFile;
  }

  private isCurrentIndexTask(file: TFile, task: PendingIndex): boolean {
    return this.pendingIndexes.get(task.path) === task && file.path === task.path &&
      file.stat.mtime === task.mtime && file.stat.size === task.size;
  }

  private removeIndexedFile(path: string): void {
    const existing = this.index.get(path);
    if (!existing) {
      return;
    }
    for (const [term, fileChunkIds] of existing.termChunkIds) {
      const ids = this.postings.get(term);
      if (!ids) continue;
      for (const chunkId of fileChunkIds) ids.delete(chunkId);
      if (ids.size === 0) this.postings.delete(term);
    }
    for (const chunk of existing.chunks) this.chunksById.delete(chunk.id);
    this.index.delete(path);
  }

  private getAuthorizedIncomingLinks(filePath: string, authorizedPaths: ReadonlySet<string>): string[] {
    if (!this.incomingLinksByTarget) {
      const incomingLinksByTarget = new Map<string, string[]>();
      for (const [sourcePath, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
        for (const targetPath of Object.keys(targets)) {
          const incoming = incomingLinksByTarget.get(targetPath) || [];
          incoming.push(sourcePath);
          incomingLinksByTarget.set(targetPath, incoming);
        }
      }
      this.incomingLinksByTarget = incomingLinksByTarget;
    }

    return (this.incomingLinksByTarget.get(filePath) || [])
      .filter((sourcePath) => authorizedPaths.has(sourcePath))
      .slice(0, 20);
  }
}

function scoreChunk(
  filePath: string,
  heading: string,
  content: string,
  semanticContext: string,
  terms: string[],
  directPhrase: string
): number {
  const normalizedPath = normalize(filePath);
  const normalizedHeading = normalize(heading);
  const normalizedContent = normalize(content);
  const normalizedSemantics = normalize(semanticContext);
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

    score += countOccurrences(normalizedContent, term, SCORE_CONTENT_MAX);
    score += countOccurrences(normalizedSemantics, term, 3);
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
    }

    for (let index = 0; index < block.length - 1; index += 1) {
      terms.add(block.slice(index, index + 2));
    }

    if (block.length > 4) {
      for (let index = 0; index < block.length - 2; index += 1) {
        terms.add(block.slice(index, index + 3));
      }
    }
  }

  return Array.from(terms).filter((term) => term.length > 1);
}

function extractIndexTerms(value: string): Set<string> {
  const normalized = normalize(value);
  const terms = new Set<string>(normalized.match(/[a-z0-9_#/-]{2,}/g) || []);
  const cjkBlocks = normalized.match(/[\u3400-\u9fff\u{20000}-\u{2A6DF}\u3040-\u309F\u30A0-\u30FF]+/gu) || [];
  for (const block of cjkBlocks) {
    if (block.length === 1) continue;
    if (block.length <= 4) terms.add(block);
    for (let index = 0; index < block.length - 1; index += 1) {
      terms.add(block.slice(index, index + 2));
    }
  }
  return terms;
}

function countOccurrences(value: string, term: string, limit: number): number {
  if (!term) {
    return 0;
  }

  let count = 0;
  let index = value.indexOf(term);

  while (index !== -1) {
    count += 1;
    if (count >= limit) return count;
    index = value.indexOf(term, index + term.length);
  }

  return count;
}

function normalize(value: string): string {
  return value.toLowerCase().trim();
}
