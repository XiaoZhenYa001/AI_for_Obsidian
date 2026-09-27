const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const { TextSearchService } = loadTs("src/retrieval/text-search.ts");

function note(path, content = "apple") {
  return { path, content, stat: { mtime: 1, size: content.length } };
}

function createApp(resolvedLinks = {}) {
  return {
    vault: { cachedRead: async (file) => file.content },
    metadataCache: { resolvedLinks }
  };
}

test("a previous scope cannot crowd matching files out of the current scope", async () => {
  const service = new TextSearchService(createApp());
  const previousFiles = Array.from({ length: 1600 }, (_, index) => note(`Previous/${index}.md`));
  const currentFiles = [note("Current/first.md"), note("Current/second.md")];

  await service.search("apple", previousFiles);
  const results = await service.search("apple", currentFiles);

  assert.deepEqual(Array.from(results, (chunk) => chunk.filePath).sort(), currentFiles.map((file) => file.path).sort());
});

test("backlinks are structured and limited to the requested file scope for every document format", async () => {
  const documents = [
    note("Public.md"),
    note("Public.canvas", JSON.stringify({ nodes: [{ id: "a", type: "text", text: "apple" }], edges: [] })),
    note("Public.excalidraw", JSON.stringify({ elements: [{ type: "text", text: "apple" }] }))
  ];
  const allowedSource = note("Allowed.md");
  const sources = [...Array.from({ length: 25 }, (_, index) => `Private/Secret ${index}.md`), allowedSource.path];
  const resolvedLinks = Object.fromEntries(sources.map((path) => [
    path, Object.fromEntries(documents.map((file) => [file.path, 1]))
  ]));
  const service = new TextSearchService(createApp(resolvedLinks));

  const results = await service.search("apple", [...documents, allowedSource]);
  for (const file of documents) {
    const chunk = results.find((result) => result.filePath === file.path);
    assert.ok(chunk, `expected a result for ${file.path}`);
    assert.equal(chunk.semanticContext?.includes("反向链接") ?? false, false);
    assert.deepEqual(Array.from(chunk.incomingLinks || []), [allowedSource.path]);
    assert.equal(JSON.stringify(chunk).includes("Private/"), false);
  }

  const narrowed = await service.search("no-match", [documents[0]]);
  assert.deepEqual(Array.from(narrowed[0].incomingLinks || []), []);
  assert.equal(JSON.stringify(narrowed).includes(allowedSource.path), false);

  const covered = await service.getRepresentativeChunks([documents[0]], 1, new Set([documents[0].path, allowedSource.path]));
  assert.deepEqual(Array.from(covered[0].incomingLinks || []), [allowedSource.path]);
});

test("a search batch scans the link graph once and reuses it until links change", async () => {
  const files = Array.from({ length: 50 }, (_, index) => note(`Note${index}.md`));
  const resolvedLinks = {};
  let graphSourceReads = 0;
  let fileReads = 0;
  const firstSourceTargets = { [files[1].path]: 1 };
  for (const [index, file] of files.entries()) {
    Object.defineProperty(resolvedLinks, file.path, {
      enumerable: true,
      get: () => {
        graphSourceReads += 1;
        return index === 0 ? firstSourceTargets : {};
      }
    });
  }
  const app = createApp(resolvedLinks);
  app.vault.cachedRead = async (file) => {
    fileReads += 1;
    return file.content;
  };
  const service = new TextSearchService(app);

  await service.search("apple", files);
  assert.equal(graphSourceReads, files.length);
  const initial = await service.getRepresentativeChunks(files);
  assert.equal(graphSourceReads, files.length);
  assert.deepEqual(Array.from(initial[1].incomingLinks || []), [files[0].path]);

  delete firstSourceTargets[files[1].path];
  firstSourceTargets[files[2].path] = 1;
  service.invalidateLinks();
  const updated = await service.getRepresentativeChunks(files);
  assert.equal(graphSourceReads, files.length * 2);
  assert.equal(fileReads, files.length, "changing backlinks does not require rereading note contents");
  assert.deepEqual(Array.from(updated[1].incomingLinks || []), []);
  assert.deepEqual(Array.from(updated[2].incomingLinks || []), [files[0].path]);
});
