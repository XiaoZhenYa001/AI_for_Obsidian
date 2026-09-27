const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
class Component {
  addChild(child) { return child; }
  removeChild(child) { return child; }
  register() {}
  registerEvent() {}
  registerDomEvent() {}
}
class TAbstractFile {
  constructor(filePath = '') { this.path = filePath; this.name = filePath.split('/').pop(); }
}
class TFile extends TAbstractFile {
  constructor(filePath = '') {
    super(filePath);
    this.extension = filePath.split('.').pop();
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.stat = { mtime: 1, ctime: 1, size: 1 };
  }
}
class TFolder extends TAbstractFile { children = []; }
class Plugin extends Component {}
class ItemView extends Component {}
class FileView extends ItemView {}
class Modal extends Component {}
const obsidian = {
  Component, TAbstractFile, TFile, TFolder, Plugin, ItemView, FileView, Modal,
  MarkdownView: class extends FileView {}, PluginSettingTab: class {},
  FuzzySuggestModal: class extends Modal {}, SuggestModal: class extends Modal {},
  Notice: class {}, Setting: class {}, Menu: class {},
  normalizePath: value => value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, ''),
  parseYaml: () => ({}), setIcon() {}, MarkdownRenderer: { async render() {} }
};

function loadTs(relativePath, mocks = {}, globals = {}) {
  const cache = new Map();
  const context = vm.createContext({
    console, crypto: require('node:crypto').webcrypto, AbortController, AbortSignal,
    Error, SyntaxError, TypeError, RangeError, DOMException, JSON,
    TextEncoder, TextDecoder, Response, Request, Headers, ReadableStream,
    fetch: (...args) => globalThis.fetch(...args), URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, performance, ...globals
  });
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const localRequire = specifier => {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
      if (specifier === 'obsidian') return obsidian;
      if (!specifier.startsWith('.')) return require(specifier);
      const base = path.resolve(path.dirname(filename), specifier);
      const resolved = [base, `${base}.ts`, path.join(base, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
      const key = path.relative(root, resolved || base).replace(/\\/g, '/');
      if (Object.hasOwn(mocks, key)) return mocks[key];
      if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${filename}`);
      return load(resolved);
    };
    const run = vm.runInContext(`(function(exports, require, module) {\n${code}\n})`, context, { filename });
    run(module.exports, localRequire, module);
    return module.exports;
  }
  return load(path.resolve(root, relativePath));
}

module.exports = { loadTs, obsidian, TFile, TFolder };
