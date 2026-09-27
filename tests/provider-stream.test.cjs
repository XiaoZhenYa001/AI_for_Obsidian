const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const providers = [
  {
    file: "openai-compatible", name: "OpenAICompatibleProvider",
    delta: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    error: 'data: {"error":{"message":"quota exhausted"}}\n\n',
    done: 'data: [DONE]\n\n'
  },
  {
    file: "anthropic", name: "AnthropicProvider",
    delta: 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
    error: 'event: error\ndata: {"type":"error","error":{"message":"quota exhausted"}}\n\n',
    done: 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  },
  {
    file: "ollama", name: "OllamaProvider",
    delta: '{"message":{"content":"partial"},"done":false}\n',
    error: '{"error":"quota exhausted"}\n',
    done: '{"done":true}\n'
  }
];

function createProvider(spec) {
  const Provider = loadTs(`src/providers/${spec.file}.ts`)[spec.name];
  return new Provider({
    id: "test", name: "Test", type: spec.file, apiKey: "test-key",
    defaultModel: "test-model", temperature: 0.1, stream: true, enabled: true
  });
}

async function withResponse(t, body, run) {
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 200 }));
  return run();
}

async function readStream(provider, options = {}) {
  const chunks = [];
  for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hello" }], ...options })) {
    chunks.push(event.content);
  }
  return chunks.join("");
}

for (const spec of providers) {
  test(`${spec.file}: a provider error after partial content fails the request`, async (t) => {
    await withResponse(t, spec.delta + spec.error + spec.done, async () => {
      await assert.rejects(readStream(createProvider(spec)), (error) => {
        assert.equal(error.code, "stream-error");
        assert.match(error.message, /quota exhausted/);
        return true;
      });
    });
  });

  test(`${spec.file}: disconnecting before the completion marker fails the request`, async (t) => {
    await withResponse(t, spec.delta, async () => {
      await assert.rejects(readStream(createProvider(spec)), { code: "invalid-response" });
    });
  });

  test(`${spec.file}: a complete stream preserves content, including a final frame without newline`, async (t) => {
    await withResponse(t, spec.delta + spec.done.trimEnd(), async () => {
      assert.equal(await readStream(createProvider(spec)), "partial");
    });
  });

  test(`${spec.file}: a completion marker without any answer is an empty response`, async (t) => {
    await withResponse(t, spec.done, async () => {
      await assert.rejects(readStream(createProvider(spec)), { code: "empty-response" });
    });
  });

  test(`${spec.file}: malformed data cannot silently lose answer content`, async (t) => {
    const malformed = spec.file === "ollama" ? '{invalid}\n' : 'data: {invalid}\n\n';
    await withResponse(t, spec.delta + malformed + spec.done, async () => {
      await assert.rejects(readStream(createProvider(spec)), { code: "invalid-response" });
    });
  });
}

test("stopping consumption cancels the response body", async (t) => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(providers[0].delta)); },
    cancel() { cancelled = true; }
  });
  await withResponse(t, body, async () => {
    for await (const _event of createProvider(providers[0]).streamChat({ messages: [] })) break;
    assert.equal(cancelled, true);
  });
});
