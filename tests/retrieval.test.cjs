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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("overlapping searches and representative reads share one pending file read", async () => {
  const file = note("Shared.md");
  const read = deferred();
  const app = createApp();
  let reads = 0;
  app.vault.cachedRead = () => { reads += 1; return read.promise; };
  const service = new TextSearchService(app);
  const searches = [service.search("apple", [file]), service.search("apple", [file]), service.getRepresentativeChunks([file])];
  assert.equal(reads, 1);
  read.resolve(file.content);
  for (const results of await Promise.all(searches)) assert.equal(results[0].content, "apple");
  await service.search("apple", [file]);
  assert.equal(reads, 1, "a warm search needs no additional file IO");
});

test("an invalidated read cannot replace newer content or leave stale postings", async () => {
  const file = note("Changing.md", "obsolete");
  const reads = [deferred(), deferred()];
  let readCount = 0;
  const app = createApp();
  app.vault.cachedRead = () => reads[readCount++].promise;
  const service = new TextSearchService(app);
  const oldSearch = service.search("obsolete", [file]);
  service.invalidateFile(file.path);
  file.content = "fresh";
  file.stat.mtime += 1;
  file.stat.size = file.content.length;
  const freshSearch = service.search("fresh", [file]);
  reads[1].resolve(file.content);
  assert.equal((await freshSearch)[0].content, "fresh");
  reads[0].resolve("obsolete");
  await oldSearch;
  const latest = await service.search("obsolete", [file]);
  assert.equal(latest[0].content, "fresh");
  assert.equal(latest[0].score, 0.1, "obsolete postings must not score a replacement chunk");
  assert.equal(readCount, 2);
});

test("a changed stat without an invalidation event cannot label old bytes as current", async () => {
  const file = note("Changing.md", "obsolete");
  const read = deferred();
  const app = createApp();
  app.vault.cachedRead = () => read.promise;
  const service = new TextSearchService(app);
  const search = service.search("obsolete", [file]);
  file.stat.mtime += 1;
  read.resolve("obsolete");
  assert.equal((await search).length, 0);
  assert.equal(service.getStats().indexedFiles, 0);
  app.vault.cachedRead = async () => "fresh";
  assert.equal((await service.search("fresh", [file]))[0].content, "fresh");
});

test("clearing an index cancels publication and remaining batches of an earlier rebuild", async () => {
  const read = deferred();
  const files = Array.from({ length: 24 }, (_, index) => note(`Note${index}.md`));
  const app = createApp();
  let readCount = 0;
  app.vault.cachedRead = () => { readCount += 1; return read.promise; };
  const service = new TextSearchService(app);
  const rebuild = service.rebuild(files);
  const startedReads = readCount;
  service.clear();
  read.resolve("apple");
  await rebuild;
  assert.equal(service.getStats().indexedFiles, 0);
  assert.equal(service.getStats().lastRebuildAt, undefined);
  assert.equal(readCount, startedReads, "cancelled batches must not continue reading the vault");
  assert.ok(readCount < files.length);
});

test("a failed shared read is retried by the next search", async () => {
  const file = note("Retry.md");
  const read = deferred();
  const app = createApp();
  let readCount = 0;
  app.vault.cachedRead = () => { readCount += 1; return read.promise; };
  const service = new TextSearchService(app);
  const searches = Promise.allSettled([service.search("apple", [file]), service.search("apple", [file])]);
  read.reject(new Error("temporary read error"));
  assert.ok((await searches).every(result => result.status === "rejected"));
  assert.equal(readCount, 1);
  app.vault.cachedRead = async () => file.content;
  assert.equal((await service.search("apple", [file]))[0].content, "apple");
});

test("a cold multi-file index yields to queued UI work, with no periodic work after completion", async () => {
  let time = 0;
  let timers = 0;
  const { TextSearchService: BudgetedSearch } = loadTs("src/retrieval/text-search.ts", {}, {
    performance: { now: () => (time += 10) },
    setTimeout: (callback, delay) => { timers += 1; return setTimeout(callback, delay); }
  });
  const service = new BudgetedSearch(createApp());
  let uiWorkRan = false;
  setTimeout(() => { uiWorkRan = true; }, 0);
  await service.search("apple", Array.from({ length: 32 }, (_, index) => note(`Note${index}.md`)));
  assert.equal(uiWorkRan, true, "a busy index must let the host process queued UI work");
  const completedTimers = timers;
  assert.ok(completedTimers > 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(timers, completedTimers, "an idle index has no background timer");
});
