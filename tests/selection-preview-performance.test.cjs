const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, obsidian } = require('./helpers/load-ts.cjs');

function fixture() {
  const timers = new Map();
  const windowListeners = new Map();
  const stats = { writes: 0, heightResets: 0, cancelled: 0 };
  let nextTimer = 0, widthFactor = 1;
  const ownerWindow = {
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, handler) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(handler); },
    removeEventListener(type, handler) { windowListeners.get(type)?.delete(handler); }
  };
  const doc = { defaultView: ownerWindow };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.ownerDocument = doc; this.children = []; this.listeners = new Map();
      this._value = ''; this._top = 0; this._height = '96px';
      this.style = {};
      Object.defineProperty(this.style, 'height', { get: () => this._height, set: value => {
        if (this.tagName === 'textarea' && value === 'auto') stats.heightResets++;
        this._height = value; this._top = 0;
      } });
    }
    addClass() {} removeClass() {}
    empty() { this.children = []; }
    createEl(tag, options = {}) { const element = new Element(tag); element.className = options.cls || ''; this.children.push(element); return element; }
    createDiv(options) { return this.createEl('div', options); }
    createSpan(options) { return this.createEl('span', options); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    removeEventListener(type) { this.listeners.delete(type); }
    removeAttribute() {}
    get value() { return this._value; }
    set value(value) { this._value = value; this._top = 0; stats.writes++; }
    get clientHeight() { return this._height === 'auto' ? 96 : Number.parseFloat(this._height); }
    get scrollHeight() { return Math.max(this.clientHeight, 96 + this._value.length * 2 * widthFactor); }
    get scrollTop() { return this._top; }
    set scrollTop(value) { this._top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  }
  class Modal extends obsidian.Modal {
    constructor() { super(); this.modalEl = new Element(); this.contentEl = new Element(); }
  }
  const { SelectionPreviewModal } = loadTs('src/ui/selection-preview-modal.ts', { obsidian: { ...obsidian, Modal } });
  const modal = new SelectionPreviewModal({}, { actionLabel: 'Rewrite', fileName: 'note.md', startLine: 1, before: '', original: 'original', after: '' }, () => {}, () => {}, () => { stats.cancelled++; });
  modal.onOpen();
  const editor = modal.proposedEl;
  stats.writes = 0; stats.heightResets = 0;
  return {
    modal, editor, timers, stats, windowListeners,
    flush() { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.fn()); },
    resize(factor) { widthFactor = factor; windowListeners.get('resize')?.forEach(handler => handler()); }
  };
}

test('selection preview coalesces stream bursts and flushes the final text before editing', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.modal.appendDelta('chunk');
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 60);
  assert.equal(f.editor.value, '');
  f.flush();
  assert.equal(f.editor.value, 'chunk'.repeat(100));
  assert.equal(f.stats.writes, 1);
  f.modal.appendDelta(' last');
  f.modal.complete();
  assert.equal(f.editor.value, 'chunk'.repeat(100) + ' last');
  assert.equal(f.editor.readOnly, false);
  assert.equal(f.timers.size, 0);
  f.modal.appendDelta('late delta');
  assert.equal(f.timers.size, 0);
});

test('capped previews avoid repeated height resets but adapt to resized windows and edits', () => {
  const f = fixture();
  f.modal.appendDelta('x'.repeat(200)); f.flush();
  assert.equal(f.editor.style.height, '320px');
  assert.equal(f.stats.heightResets, 1);
  for (let i = 0; i < 10; i++) { f.modal.appendDelta('more'); f.flush(); }
  assert.equal(f.stats.heightResets, 1);
  f.resize(0.1);
  assert.equal(f.editor.style.height, '144px');
  f.modal.appendDelta('more'); f.flush();
  assert.equal(f.editor.style.height, '144.8px');
  f.modal.complete();
  f.editor.value = 'short';
  f.editor.listeners.get('input')();
  assert.equal(f.editor.style.height, '97px');
});

test('selection preview follows output near the bottom and preserves an upward reading position', () => {
  const f = fixture();
  f.modal.appendDelta('x'.repeat(500)); f.flush();
  assert.equal(f.editor.scrollTop, f.editor.scrollHeight - f.editor.clientHeight);
  f.editor.scrollTop = 40;
  f.modal.appendDelta('more text'); f.flush();
  assert.equal(f.editor.scrollTop, 40);
  f.editor.scrollTop = f.editor.scrollHeight - f.editor.clientHeight - 10;
  f.modal.appendDelta('more text'); f.flush();
  assert.equal(f.editor.scrollTop, f.editor.scrollHeight - f.editor.clientHeight);
});

test('failure flushes partial content and closing cancels pending renders and listeners', () => {
  const failed = fixture();
  failed.modal.appendDelta('partial answer');
  failed.modal.fail('failed');
  assert.equal(failed.editor.value, 'partial answer');
  assert.equal(failed.timers.size, 0);
  failed.modal.appendDelta('late');
  assert.equal(failed.timers.size, 0);

  const closed = fixture();
  closed.modal.appendDelta('pending');
  closed.modal.onClose();
  closed.flush();
  closed.modal.appendDelta('late');
  assert.equal(closed.editor.value, '');
  assert.equal(closed.timers.size, 0);
  assert.equal(closed.stats.cancelled, 1);
  assert.equal([...closed.windowListeners.values()].every(listeners => listeners.size === 0), true);
});
