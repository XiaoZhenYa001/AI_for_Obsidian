const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadTs, TFile } = require("./helpers/load-ts.cjs");

function makeScope(id, allowCloudModels = true, paths = ["A.md", "B.md"]) {
  return {
    id, name: id, mode: "files", files: paths, folders: [], tags: [],
    pathRules: [], excludeRules: [], allowCloudModels
  };
}

function createFixture({ type = "openai-compatible", scope = makeScope("current"), chunks = [] } = {}) {
  const requests = [];
  const retrievalCalls = [];
  const files = scope.files.map(path => new TFile(path));
  const provider = {
    id: "test", config: { type, defaultModel: "test-model", temperature: 0.1, stream: false },
    async chat(request) { requests.push(request); return { content: "answer" }; }
  };
  const plugin = {
    providerRegistry: { get: () => provider, getFirstAvailable: () => provider },
    settings: { defaultChatProviderId: "test", contextScopes: [scope] },
    getActiveContextScope: () => scope,
    contextScopeResolver: { resolve: current => files.filter(file => current?.files.includes(file.path)) },
    textSearchService: {
      async search(_query, selectedFiles) {
        retrievalCalls.push(selectedFiles.map(file => file.path));
        return chunks.filter(chunk => selectedFiles.some(file => file.path === chunk.filePath)).slice(0, 1);
      },
      async getRepresentativeChunks(selectedFiles) {
        return chunks.filter(chunk => selectedFiles.some(file => file.path === chunk.filePath));
      }
    },
    app: { metadataCache: { getFirstLinkpathDest: name => files.find(file => file.path === `${name}.md`) } }
  };
  const { ChatService } = loadTs("src/chat/chat-service.ts");
  return { service: new ChatService(plugin), plugin, requests, retrievalCalls };
}

for (const method of ["sendMessage", "streamMessage"]) {
  test(`${method}: disabling retrieval does not disable the current scope cloud policy`, async () => {
    const fixture = createFixture({ scope: makeScope("private", false) });
    await assert.rejects(fixture.service[method]("private selected note text", { useContext: false }), /禁止云端/);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.retrievalCalls.length, 0);
  });

  test(`${method}: an explicit source scope protects directly supplied content`, async () => {
    const fixture = createFixture();
    await assert.rejects(fixture.service[method]("private drawing text", {
      useContext: false, contextScope: makeScope("drawing", false)
    }), /禁止云端/);
    assert.equal(fixture.requests.length, 0);
  });
}

test("a local provider may handle protected direct content without retrieving extra notes", async () => {
  const fixture = createFixture({ type: "ollama", scope: makeScope("private", false) });
  assert.equal((await fixture.service.sendMessage("selected text", { useContext: false })).content, "answer");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.retrievalCalls.length, 0);
});

test("an explicit scope id still applies when retrieval is disabled", async () => {
  const fixture = createFixture();
  fixture.plugin.settings.contextScopes.push(makeScope("private", false));
  await assert.rejects(fixture.service.sendMessage("private text", {
    useContext: false, contextScopeId: "private"
  }), /禁止云端/);
  assert.equal(fixture.requests.length, 0);
});

test("a missing explicit scope cannot silently bypass its privacy rules", async () => {
  const fixture = createFixture();
  await assert.rejects(fixture.service.sendMessage("private text", {
    useContext: false, contextScopeId: "deleted"
  }), /上下文范围.*不存在/);
  assert.equal(fixture.requests.length, 0);
});

function chunk(path, content, extra = {}) {
  return { id: path, filePath: path, content, startLine: 1, endLine: 1, score: 1, ...extra };
}

for (const locked of [false, true]) {
  test(`embedded notes respect this request's selection${locked ? " including locked files" : ""}`, async () => {
    const fixture = createFixture({ chunks: [
      chunk("A.md", "Public material ![[B]]"), chunk("B.md", "PRIVATE_B_CONTENT")
    ] });
    const response = await fixture.service.sendMessage("Summarize A", {
      contextFilePaths: ["A.md"], lockedFilePaths: locked ? ["B.md"] : []
    });
    const sent = fixture.requests[0].messages.map(message => message.content).join("\n");
    assert.equal(sent.includes("PRIVATE_B_CONTENT"), locked);
    assert.equal(response.citations.some(citation => citation.filePath === "B.md"), locked);
  });
}

test("backlink metadata includes only files selected or locked for this request", async () => {
  const fixture = createFixture({
    scope: makeScope("current", true, ["A.md", "Allowed.md", "Locked.md", "Removed.md"]),
    chunks: [chunk("A.md", "Public material", {
      semanticContext: "Title: A",
      incomingLinks: ["Allowed.md", "Locked.md", "Removed.md", "Private/secret.md"]
    })]
  });
  await fixture.service.sendMessage("Summarize A", {
    contextFilePaths: ["A.md", "Allowed.md"], lockedFilePaths: ["Locked.md"]
  });
  const sent = fixture.requests[0].messages.map(message => message.content).join("\n");
  assert.match(sent, /Allowed\.md/);
  assert.match(sent, /Locked\.md/);
  assert.doesNotMatch(sent, /Removed\.md|Private\/secret\.md/);
  assert.match(sent, /Title: A/);
});
