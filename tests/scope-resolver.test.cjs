const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTs, TFile, TFolder } = require("./helpers/load-ts.cjs");
const { ContextScopeResolver } = loadTs("src/context/scope-resolver.ts");

function scope(overrides = {}) {
  return { mode: "files", files: [], folders: [], tags: [], pathRules: [], excludeRules: [], ...overrides };
}

test("explicit file scopes resolve only requested paths without enumerating the vault", () => {
  const files = [new TFile("Note.md"), new TFile("Drawing.excalidraw"), new TFile("Board.canvas"),
    new TFile("Private/Excluded.md"), new TFile("image.png"), new TFolder("Folder")];
  const byPath = new Map(files.map(file => [file.path, file]));
  const lookups = [];
  const resolver = new ContextScopeResolver({
    vault: {
      getAllLoadedFiles() { throw new Error("must not scan the vault"); },
      getAbstractFileByPath(path) { lookups.push(path); return byPath.get(path); }
    }
  });
  const selected = ["Drawing.excalidraw", "Note.md", "Drawing.excalidraw", "Board.canvas", "missing.md", "image.png", "Folder", "Private/Excluded.md"];
  const result = resolver.resolve(scope({ files: selected, excludeRules: ["Private/"] }));
  assert.deepEqual(Array.from(result, file => file.path), ["Drawing.excalidraw", "Note.md", "Board.canvas"]);
  assert.equal(lookups.length, new Set(selected).size);
  assert.deepEqual(Array.from(resolver.resolve(scope({ mode: "mixed", files: ["Note.md"] })), file => file.path), ["Note.md"]);
});

test("mixed folder scopes retain inclusion and exclusion behavior", () => {
  const files = [new TFile("Picked.md"), new TFile("Folder/Note.md"), new TFile("Folder/Private.md"), new TFile("Elsewhere.md")];
  let scans = 0;
  const resolver = new ContextScopeResolver({ vault: { getAllLoadedFiles() { scans += 1; return files; } } });
  const result = resolver.resolve(scope({ mode: "mixed", files: ["Picked.md"], folders: ["Folder/"], excludeRules: ["Private"] }));
  assert.deepEqual(Array.from(result, file => file.path), ["Picked.md", "Folder/Note.md"]);
  assert.equal(scans, 1);
});
