// Test-only bridge: the browser harness uses the production HTTP server.
const http = require('http');
const { loadTs } = require('../helpers/load-ts.cjs');
const { startHtmlPreviewServer } = loadTs('src/html/html-preview-server.ts');
const sessions = new Map();
let nextId = 0;
let networkRequests = 0;
let controlOrigin;
const resources = new Map([
  ['site/style.css', 'body{font:18px system-ui;margin:24px;background:#f5f7fb}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{padding:20px;background:white;border-radius:12px}h1{color:rgb(12,100,180)}button{padding:10px}iframe{height:90px;border:1px solid #ddd}img{width:64px;height:64px}'],
  ['site/app.js', `import {answer} from './math.js'; const data=await (await fetch('./data.json')).json();document.body.dataset.module=String(answer+data.value);localStorage.setItem('preview-test','works');document.body.dataset.storage=localStorage.getItem('preview-test');document.body.dataset.eval=String(new Function('return 6*7')());document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent='submitted'};try{parent.document.body.dataset.exposed='yes'}catch{document.body.dataset.parent='blocked'}document.body.dataset.node=typeof require;`],
  ['site/math.js', 'export const answer=40;'], ['site/data.json', '{"value":2}'],
  ['site/picture.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#7054df"/></svg>'],
  ['site/child.html', '<!doctype html><body style="background:#edfbe9;font:16px system-ui">嵌入页面完整显示</body>']
]);
function source() { return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><base href="./"><title>完整 HTML</title><link rel="stylesheet" href="./style.css"></head><body><h1>完整 HTML 预览</h1><div class="grid"><section class="card"><h2>模块与数据</h2><p>ES Module、JSON、存储与动态脚本</p><form><input aria-label="示例输入" value="完整交互"><button>提交</button></form><output id="result"></output></section><section class="card"><h2>原始媒体与嵌入</h2><picture><source srcset="./picture.svg" type="image/svg+xml"><img alt="测试图形"></picture><iframe title="页面内嵌入" src="./child.html"></iframe></section></div><script type="module" src="./app.js"></script><script src="${controlOrigin}/online.js"></script></body></html>`; }
const control = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/online.js') { networkRequests++; res.setHeader('Content-Type', 'text/javascript'); res.end('document.body.dataset.online="loaded"'); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : {};
  let result = {};
  if (req.url === '/new') {
    const server = await startHtmlPreviewServer({ filePath: 'site/index.html', allowNetwork: data.allowNetwork,
      readFile: async path => { const value = path === 'site/index.html' ? source() : resources.get(path); return value === undefined ? undefined : { data: value }; } });
    const id = String(++nextId); sessions.set(id, server); result = { id, url: server.url, origin: server.origin };
  } else if (req.url.startsWith('/network/')) sessions.get(req.url.split('/').pop()).setAllowNetwork(data.value);
  else if (req.url.startsWith('/close/')) { const id = req.url.split('/').pop(); await sessions.get(id)?.close(); sessions.delete(id); }
  else if (req.url === '/source') result = { source: source() };
  else if (req.url === '/stats') result = { active: sessions.size, networkRequests };
  else { res.statusCode = 404; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
});
control.listen(0, '127.0.0.1', () => { controlOrigin = `http://127.0.0.1:${control.address().port}`; process.stdout.write(JSON.stringify({controlOrigin})+'\n'); });
