const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs, TFile } = require('./helpers/load-ts.cjs');
const { parseDrawingEditPlan, isDrawingEditRequest } = loadTs('src/diagrams/drawing-edit-plan.ts');
const { ExcalidrawEditService } = loadTs('src/diagrams/excalidraw-edit-service.ts');
const title = { id: 'title', type: 'text', x: 100, y: 200, width: 180, height: 30, fontSize: 24, text: '项目计划', version: 1 };

function fixture() {
  const file = new TFile('Board.excalidraw.md');
  const view = { file, getViewType: () => 'excalidraw' };
  const state = { elements: [structuredClone(title), { id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 100, fileId: 'keep' }], commits: 0, destroyed: 0, args: undefined };
  const root = { getAPI() {
    const work = new Map();
    return {
      style: { fontSize: 20 },
      getExcalidrawAPI: () => ({}),
      getViewElements: () => state.elements,
      getViewSelectedElements: () => [state.elements[0]],
      copyViewElementsToEAforEditing: elements => elements.forEach(el => work.set(el.id, structuredClone(el))),
      getElement: id => work.get(id),
      refreshTextElementSize(id) { const element = work.get(id); element.width = element.text.length * element.fontSize; element.height = element.fontSize * 1.25; },
      addText(x, y, text) { const id = `new-${work.size}`; work.set(id, { id, type: 'text', x, y, text, fontSize: this.style.fontSize }); return id; },
      async addElementsToView(...args) {
        state.args = args;
        state.commits++;
        if (state.wait) await state.wait;
        if (state.fail) return false;
        state.elements = [...new Map([...state.elements.map(el => [el.id, el]), ...work]).values()];
        return true;
      },
      destroy() { state.destroyed++; }
    };
  } };
  const plugin = {
    settings: { defaultEditProviderId: 'edit' },
    getActiveContextScope: () => ({ allowCloudModels: false }),
    app: { workspace: { getLeavesOfType: () => [{ view }] }, vault: { getAbstractFileByPath: path => path === file.path ? file : null } },
    chatService: { async sendMessage(_content, options) { state.options = options; return { content: JSON.stringify({ edits: [{ type: 'add-text', text: '待办', anchorId: 'title', position: 'below' }] }) }; } }
  };
  return { file, view, state, service: new ExcalidrawEditService(plugin, () => root) };
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
