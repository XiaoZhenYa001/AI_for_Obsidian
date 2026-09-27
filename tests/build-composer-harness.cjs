const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.test-output');
fs.mkdirSync(out, { recursive: true });
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'ui/composer-harness.ts')], bundle: true, format: 'iife', outfile: path.join(out, 'composer.js'), alias: { obsidian: path.join(__dirname, 'ui/obsidian.ts') } });
fs.writeFileSync(path.join(out, 'composer.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../styles.css"><style>:root{--background-modifier-border:#ddd;--text-normal:#222;--background-primary:#fff;--text-muted:#666;--text-on-accent:white;--interactive-accent:#8b5cf6;--font-text:system-ui}body{font:15px system-ui;margin:0;padding:20px;background:#f3f4f6}.composer-fixture{width:550px;background:#fff}button,textarea{font:inherit}button{border:1px solid #ddd;padding:8px;border-radius:6px}textarea{border:1px solid #bbb}.ai-second-brain-button-icon{background:#888;border-radius:3px;min-width:16px}</style><script defer src="composer.js"></script>');
