const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
require('./build-chat-harness.cjs');
const out = path.resolve(__dirname, '../.test-output');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'ui/motion-harness.ts')], bundle: true,
  format: 'iife', outfile: path.join(out, 'motion.js'),
  alias: { obsidian: path.join(__dirname, 'ui/obsidian.ts') } });
fs.writeFileSync(path.join(out, 'motion.html'), fs.readFileSync(path.join(out, 'chat-workflow.html'), 'utf8')
  .replace('chat-workflow.js', 'motion.js'));
