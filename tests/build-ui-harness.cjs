const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.test-output');
fs.mkdirSync(out, { recursive: true });
(async () => {
  await esbuild.build({ entryPoints: [path.join(__dirname, 'ui/drawing-harness.ts')], bundle: true, format: 'iife', outfile: path.join(out, 'drawing.js'), alias: { obsidian: path.join(__dirname, 'ui/obsidian.ts') } });
  fs.writeFileSync(path.join(out, 'drawing.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../styles.css"><style>:root{--background-modifier-border:#ddd;--text-normal:#222;--background-primary:#fff}body{font:15px system-ui;padding:24px;background:#f3f4f6}.modal{max-width:760px;margin:auto;background:white;padding:24px;border-radius:12px}.setting-item{display:flex;justify-content:space-between;gap:20px;margin:16px 0}.setting-item-control{display:flex;gap:8px}textarea{min-width:300px;font:inherit}button,input,select{font:inherit;padding:8px}button:disabled{opacity:.5}.notice{padding:10px;color:#b42318}</style><script src="drawing.js"></script>');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'ui/html-harness.ts')], bundle: true, format: 'iife', outfile: path.join(out, 'html.js'), alias: { obsidian: path.join(__dirname, 'ui/obsidian.ts') } });
  fs.writeFileSync(path.join(out, 'html.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../styles.css"><style>:root{--background-modifier-border:#ddd;--text-normal:#222;--background-primary:#fff;--text-muted:#666;--text-on-accent:white;--interactive-accent:#2563eb}body{font:15px system-ui;margin:16px}.fixture-view{height:90vh}.fixture-view>div{height:100%}button{font:inherit;padding:8px}</style><script defer src="html.js"></script>');
})();
