const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, TFile } = require('./helpers/load-ts.cjs');
const { KnowledgeAnalysisService } = loadTs('src/knowledge/analysis-service.ts');

test('analysis coalesces simultaneous requests, caps reads at 8 and returns stable top 50', async () => {
  const files = Array.from({ length: 40 }, (_, n) => new TFile(`Note-${n}.md`));
  const content = files.map(file => file.basename).join(' ');
  let active = 0, peak = 0, reads = 0, yielded = false;
  const service = new KnowledgeAnalysisService({
    vault: { cachedRead: async () => { reads++; peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 1)); active--; return content; } },
    metadataCache: { resolvedLinks: {}, getFileCache: () => ({ frontmatter: { tags: ['shared', 'common'] } }) }
  });
  setTimeout(() => yielded = true, 0);
  const [one, two] = await Promise.all([service.analyze('scope', files), service.analyze('scope', files)]);
  assert.equal(one, two); assert.equal(reads, 40); assert.equal(peak, 8); assert.equal(yielded, true);
  assert.equal(one.notes.length, 40); assert.equal(one.linkSuggestions.length, 50);
  const expected = files.flatMap(source => files.filter(target => target !== source).map(target => ({ sourcePath: source.path, targetPath: target.path })));
  assert.deepEqual(JSON.parse(JSON.stringify(one.linkSuggestions.map(({ sourcePath, targetPath }) => ({ sourcePath, targetPath })))), expected.slice(0, 50));
  await service.analyze('scope', files); assert.equal(reads, 40);
  files[0].stat.mtime++;
  await service.analyze('scope', files); assert.equal(reads, 80);
});
