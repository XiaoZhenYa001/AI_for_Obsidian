import { NoteChunk } from "./types";

const DEFAULT_MAX_CHARS = 1800;

export function chunkMarkdown(
  filePath: string,
  content: string,
  maxChars = DEFAULT_MAX_CHARS,
  semanticContext = ""
): NoteChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: NoteChunk[] = [];
  let heading: string | undefined;
  let headingPath: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;
  let startLine = 1;

  const flush = (endLine: number) => {
    const text = buffer.join("\n").trim();

    if (!text) {
      buffer = [];
      bufferLength = 0;
      startLine = endLine + 1;
      return;
    }

    chunks.push({
      id: `${filePath}:${startLine}-${endLine}`,
      filePath,
      heading,
      headingPath: [...headingPath],
      semanticContext: semanticContext || undefined,
      content: text,
      startLine,
      endLine
    });

    buffer = [];
    bufferLength = 0;
    startLine = endLine + 1;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);

    if (headingMatch && buffer.length > 0) {
      flush(lineNumber - 1);
    }

    if (headingMatch) {
      heading = headingMatch[2].trim();
      const level = headingMatch[1].length;
      headingPath = [...headingPath.slice(0, level - 1), heading];
      startLine = lineNumber;
    }

    if (buffer.length > 0 && bufferLength + line.length > maxChars) {
      flush(lineNumber - 1);
      startLine = lineNumber;
    }

    buffer.push(line);
    bufferLength += (buffer.length > 1 ? 1 : 0) + line.length;
  }

  flush(lines.length);

  return chunks;
}
