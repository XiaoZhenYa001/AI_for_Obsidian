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

test('candidate filtering preserves substring, short-name, tag and tie ranking semantics', async () => {
  const files = Array.from({ length: 30 }, (_, i) => new TFile(`folder/${i === 0 ? '甲' : i === 1 ? 'ab' : `note-${i}`}.md`));
  const contents = files.map((file, i) => `甲 ab note-${(i + 1) % 30} 文本标题${(i + 3) % 30}`);
  const tags = files.map((_, i) => [`group-${i % 3}`, `theme-${i % 5}`]);
  const titles = files.map((file, i) => i % 4 === 0 ? `文本标题${i}` : file.basename);
  const app = {
    vault: { cachedRead: async file => contents[files.indexOf(file)] },
    metadataCache: { resolvedLinks: {}, getFileCache: file => {
      const i = files.indexOf(file);
      return { frontmatter: { title: titles[i], tags: tags[i] } };
    } }
  };
  const report = await new KnowledgeAnalysisService(app).analyze('scope', files);
  const expected = [];
  for (let i = 0; i < files.length; i++) for (let j = 0; j < files.length; j++) {
    if (i === j) continue;
    const title = titles[j].toLowerCase(), basename = files[j].basename.toLowerCase();
    const shared = tags[j].filter(tag => tags[i].includes(tag));
    const titleMentioned = titles[j].length >= 2 && contents[i].toLowerCase().includes(title);
    const basenameMentioned = contents[i].toLowerCase().includes(basename);
    if (!titleMentioned && !basenameMentioned && shared.length < 2) continue;
    expected.push({ sourcePath: files[i].path, targetPath: files[j].path, targetTitle: titles[j],
      reason: titleMentioned || basenameMentioned ? '正文提到了目标笔记标题' : `共享标签：${shared.join(', ')}`,
      score: (titleMentioned ? 5 : 0) + (basenameMentioned ? 3 : 0) + shared.length });
  }
  expected.sort((a, b) => b.score - a.score);
  assert.deepEqual(JSON.parse(JSON.stringify(report.linkSuggestions)), expected.slice(0, 50));
});
