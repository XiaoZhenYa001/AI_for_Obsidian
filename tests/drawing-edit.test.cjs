const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, TFile } = require('./helpers/load-ts.cjs');
const { parseDrawingEditPlan, isDrawingEditRequest } = loadTs('src/diagrams/drawing-edit-plan.ts');
const { ExcalidrawEditService, getInsertionPoint } = loadTs('src/diagrams/excalidraw-edit-service.ts');
const title = { id: 'title', type: 'text', x: 100, y: 200, width: 180, height: 30, fontSize: 24, text: '项目计划', version: 1 };

function fixture() {
  const file = new TFile('Board.excalidraw.md');
  const view = { file, getViewType: () => 'excalidraw', async save() { state.saves++; } };
  const state = { elements: [structuredClone(title), { id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 100, fileId: 'keep' }], commits: 0, destroyed: 0, args: undefined, saves: 0, nextId: 0, appState: { viewModeEnabled: false, zoom: { value: 0.75 }, scrollX: 123, scrollY: -80, width: 900, height: 600 } };
  const scene = { getAppState: () => state.appState, updateScene({ appState }) { Object.assign(state.appState, appState); } };
  const root = { getAPI() {
    const work = new Map();
    return {
      style: { fontSize: 20 },
      getExcalidrawAPI: () => scene,
      clear() { work.clear(); },
      setViewModeEnabled(value) { state.appState.viewModeEnabled = value; },
      viewUpdateScene({ elements }) { if (elements) state.elements = structuredClone(elements); },
      getViewElements: () => state.elements,
      getViewSelectedElements: () => [state.elements[0]],
      copyViewElementsToEAforEditing: elements => elements.forEach(el => work.set(el.id, structuredClone(el))),
      getElement: id => work.get(id),
      refreshTextElementSize(id) { const element = work.get(id); element.width = element.text.length * element.fontSize; element.height = element.fontSize * 1.25; },
      addText(x, y, text) { const id = `new-${state.nextId++}`; work.set(id, { id, type: 'text', x, y, text, width: 100, height: 25, fontSize: this.style.fontSize }); return id; },
      async addElementsToView(...args) {
        state.args = args;
        if (args[1]) state.commits++; else state.previews = (state.previews || 0) + 1;
        if (state.wait) await state.wait;
        if (state.fail) return false;
        state.elements = [...new Map([...state.elements.map(el => [el.id, el]), ...work]).values()];
        if (state.throwAfterWrite) throw new Error('写入后失败');
        return true;
      },
      destroy() { state.destroyed++; }
    };
  } };
  const plugin = {
    settings: { defaultEditProviderId: 'edit' },
    getActiveContextScope: () => ({ allowCloudModels: false }),
    app: { workspace: { getLeavesOfType: () => [{ view }], iterateAllLeaves(fn) { fn({ view }); }, on() { return {}; }, offref() {} }, vault: { getAbstractFileByPath: path => path === file.path ? file : null } },
    chatService: { async sendMessage(_content, options) { state.options = options; return { content: JSON.stringify({ edits: [{ type: 'add-text', text: '待办', anchorId: 'title', position: 'below' }] }) }; } }
  };
  return { file, view, state, plugin, service: new ExcalidrawEditService(plugin, () => root) };
}

test('relative positioning uses real anchor geometry', () => {
  const plan = parseDrawingEditPlan(JSON.stringify({ edits: [{ type: 'add-text', text: '下一步', anchorId: 'title', position: 'below', gap: 20 }] }), [title]);
  assert.equal(plan.edits[0].x, 100);
  assert.equal(plan.edits[0].y, 250);
  assert.throws(() => parseDrawingEditPlan(JSON.stringify({ edits: [{ type: 'add-text', text: 'test', anchorId: 'missing', position: 'below' }] }), [title]), /参照/);
});

test('rejects unsupported operations, nonfinite coordinates and missing targets', () => {
  for (const edit of [
    { type: 'delete', elementId: 'title', text: 'bad' },
    { type: 'add-text', text: 'bad', x: null, y: 0 },
    { type: 'update-text', text: 'bad', elementId: 'unknown' }
  ]) assert.throws(() => parseDrawingEditPlan(JSON.stringify({ edits: [edit] }), [title]));
});

test('capture and proposal preserve the source cloud policy and selected element IDs', async () => {
  const { file, service, state } = fixture();
  const snapshot = await service.capture(file);
  const plan = await service.propose(snapshot, '在标题下面写待办');
  assert.equal(snapshot.selectedIds[0], 'title');
  assert.equal(state.options.useContext, false);
  assert.equal(state.options.contextScope.allowCloudModels, false);
  assert.equal(plan.edits[0].y, 254);
  assert.equal(state.commits, 0);
});

test('applies exact coordinates without moving existing drawing elements', async () => {
  const { file, service, state } = fixture();
  const snapshot = await service.capture(file);
  const plan = parseDrawingEditPlan(JSON.stringify({ edits: [{ type: 'add-text', text: 'hello', x: -120, y: 350 }] }), snapshot.elements);
  await service.apply(snapshot, plan);
  assert.deepEqual(state.args, [false, true, true]);
  assert.equal(state.elements[2].x, -120);
  assert.equal(state.elements[2].y, 350);
  assert.deepEqual(state.elements[0], title);
  assert.equal(state.elements[1].fileId, 'keep');
});

test('updates text in place and keeps element identity and other objects', async () => {
  const { file, service, state } = fixture();
  const snapshot = await service.capture(file);
  const plan = parseDrawingEditPlan(JSON.stringify({ edits: [{ type: 'update-text', elementId: 'title', text: '已完成' }] }), snapshot.elements);
  await service.apply(snapshot, plan);
  assert.equal(state.elements.length, 2);
  assert.equal(state.elements[0].id, 'title');
  assert.equal(state.elements[0].text, '已完成');
  assert.equal(state.elements[0].x, title.x);
  assert.equal(state.elements[1].fileId, 'keep');
});

test('rejects a stale preview without committing over newer canvas edits', async () => {
  const { file, service, state } = fixture();
  const snapshot = await service.capture(file);
  const plan = await service.propose(snapshot, '添加文字');
  state.elements[0].text = '用户新修改';
  await assert.rejects(service.apply(snapshot, plan), /发生了变化/);
  assert.equal(state.commits, 0);
  assert.equal(state.elements[0].text, '用户新修改');
});

test('serializes commits per drawing and reports API failure', async () => {
  const { file, service, state } = fixture();
  const snapshot = await service.capture(file);
  const plan = await service.propose(snapshot, '添加文字');
  let release;
  state.wait = new Promise(resolve => { release = resolve; });
  const first = service.apply(snapshot, plan);
  await assert.rejects(service.apply(snapshot, plan), /正在应用/);
  release();
  await first;
  const next = await service.capture(file);
  state.fail = true;
  await assert.rejects(service.apply(next, plan), /未能应用/);
});

test('questions about editing or inputs remain normal chat questions', () => {
  for (const question of ['这个架构有什么值得修改的地方？', '解释输入和输出', '如何添加文字']) {
    assert.equal(isDrawingEditRequest(question), false);
  }
  for (const instruction of ['/draw 在标题下面写说明', '在标题下面添加三条待办', '请把标题改为已完成']) {
    assert.equal(isDrawingEditRequest(instruction), true);
  }
});

test('updating a bound label preserves arrow geometry and its label anchor', async () => {
  const { file, service, state } = fixture();
  const arrow = { id: 'arrow', type: 'arrow', x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] };
  state.elements[0].containerId = 'arrow';
  state.elements.push(arrow);
  const snapshot = await service.capture(file);
  const plan = parseDrawingEditPlan(JSON.stringify({ edits: [{ type: 'update-text', elementId: 'title', text: '新的较长标签' }] }), snapshot.elements);
  await service.apply(snapshot, plan);
  assert.deepEqual(state.elements.find(el => el.id === 'arrow'), arrow);
  const label = state.elements[0];
  assert.equal(label.x + label.width / 2, title.x + title.width / 2);
  assert.equal(label.y + label.height / 2, title.y + title.height / 2);
});

test('direct insertion uses selected bounds, commits once and never calls the model', async () => {
  const { service, file, state, plugin } = fixture();
  plugin.chatService.sendMessage = () => { throw new Error('unexpected model call'); };
  const snapshot = await service.capture(file);
  const plan = service.createInsertion(snapshot, '/draw literal reply\nsecond line');
  assert.equal(plan.edits[0].x, title.x);
  assert.equal(plan.edits[0].y, title.y + title.height + 24);
  await service.applyWithUndo(snapshot, plan);
  assert.equal(state.commits, 1);
  assert.equal(state.elements.at(-1).text, '/draw literal reply\nsecond line');
  assert.equal(state.appState.viewModeEnabled, false);
});

test('viewport placement accounts for zoom and scroll, selected groups use their bounds', () => {
  const point = getInsertionPoint([], { width: 800, height: 600, zoom: { value: 2 }, scrollX: 100, scrollY: -50 });
  assert.equal(point.x, 100); assert.equal(point.y, 200);
  const group = getInsertionPoint([title, { ...title, x: -40, y: 500, height: 100 }]);
  assert.equal(group.x, -40); assert.equal(group.y, 624);
});

test('refinement passes the complete unwritten plan and proposal leaves canvas untouched', async () => {
  const { service, file, state, plugin } = fixture();
  const snapshot = await service.capture(file);
  const original = await service.propose(snapshot, '添加');
  let prompt;
  const send = plugin.chatService.sendMessage;
  plugin.chatService.sendMessage = (text, options) => { prompt = text; return send(text, options); };
  await service.propose(snapshot, '再简短一点', undefined, [], original);
  assert.match(prompt, /尚未写入/); assert.ok(prompt.includes(JSON.stringify(original)));
  assert.equal(JSON.stringify(state.elements), snapshot.fingerprint);
  assert.equal(state.commits, 0); assert.equal(state.appState.viewModeEnabled, false);
});

test('stopped or failed model requests never mutate the drawing', async () => {
  const { service, file, state, plugin } = fixture();
  const snapshot = await service.capture(file);
  const controller = new AbortController();
  const send = plugin.chatService.sendMessage;
  plugin.chatService.sendMessage = async (text, options) => { controller.abort(); return send(text, options); };
  await assert.rejects(service.propose(snapshot, '添加', controller.signal), /取消/);
  plugin.chatService.sendMessage = async () => { throw new Error('连接中断'); };
  await assert.rejects(service.propose(snapshot, '添加'), /连接中断/);
  assert.equal(JSON.stringify(state.elements), snapshot.fingerprint); assert.equal(state.commits, 0);
});

test('chat undo restores edited labels, deletes only added IDs and preserves the viewport', async () => {
  const { service, file, state } = fixture();
  const snapshot = await service.capture(file);
  const plan = parseDrawingEditPlan(JSON.stringify({ edits: [
    { type: 'update-text', elementId: 'title', text: '已完成' },
    { type: 'add-text', x: 400, y: 300, text: '新文本' }
  ] }), snapshot.elements);
  const receipt = await service.applyWithUndo(snapshot, plan);
  state.appState.scrollX = 500;
  await service.undo(receipt);
  assert.equal(state.elements[0].text, title.text);
  assert.equal(state.elements[0].width, title.width);
  assert.equal(state.elements[1].fileId, 'keep');
  assert.equal(state.elements.at(-1).isDeleted, true);
  assert.equal(state.appState.scrollX, 500); assert.equal(state.commits, 2);
  await assert.rejects(service.undo(receipt), /已经撤销/);
});

test('chat undo rejects newer edits rather than restoring an old scene', async () => {
  const { service, file, state } = fixture();
  const snapshot = await service.capture(file);
  const receipt = await service.applyWithUndo(snapshot, service.createInsertion(snapshot, '新文本'));
  state.elements[0].text = '稍后手改';
  await assert.rejects(service.undo(receipt), /写入后发生了变化/);
  assert.equal(state.elements[0].text, '稍后手改'); assert.equal(state.commits, 1);
});

test('a detached target view cannot apply a preview or use a chat undo receipt', async () => {
  const { service, file, state, plugin } = fixture();
  const snapshot = await service.capture(file);
  const plan = service.createInsertion(snapshot, '新文本');
  const attached = plugin.app.workspace.getLeavesOfType;
  plugin.app.workspace.getLeavesOfType = () => [];
  await assert.rejects(service.applyWithUndo(snapshot, plan), /关闭/);
  assert.equal(state.commits, 0);
  plugin.app.workspace.getLeavesOfType = attached;
  const receipt = await service.applyWithUndo(snapshot, plan);
  plugin.app.workspace.getLeavesOfType = () => [];
  await assert.rejects(service.undo(receipt), /关闭/);
  assert.equal(state.commits, 1);
});
