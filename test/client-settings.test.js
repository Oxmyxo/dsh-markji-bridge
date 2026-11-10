import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function mount({ configured = true, failTest = false } = {}) {
  const state = [], refs = [], calls = [], effects = [];
  let cursor = 0, refCursor = 0, component, first = true;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      return [state[i], value => { state[i] = value; }];
    },
    useRef(initial) {
      const i = refCursor++;
      return refs[i] || (refs[i] = { current: initial });
    },
    useEffect(fn) { if (first) effects.push(fn); },
    useCallback: fn => fn,
  };
  const status = { key: { configured, tail: configured ? 'aaaa' : null }, cache: { cards: 3 }, data_dir: { active: '/cache', default: '/cache' } };
  const sandbox = {
    navigator: { language: 'zh-CN' },
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push(body);
      const failed = failTest && body?.action === 'testApiKey';
      return { ok: !failed, status: failed ? 400 : 200, text: async () => JSON.stringify(failed ? { ok: false, error: { message: 'Test failed' } } : body ? { ok: true } : status) };
    },
    window: { __ModuleLoader__: { load({ factory }) {
      const plugin = factory(name => { assert.equal(name, 'react'); return React; });
      plugin.apply({ effect() {}, get() { return { inject(key, fn) { fn(); }, register(options, value) { component = value; } }; } });
    } } },
  };
  vm.runInNewContext(source, sandbox);
  function render() {
    cursor = refCursor = 0;
    const tree = component({ view: 'page' });
    if (first) { first = false; effects.forEach(fn => fn()); }
    const nodes = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node.type === 'function') { walk(node.type(node.props)); return; }
      nodes.push(node);
      node.children?.flat(Infinity).forEach(walk);
    }
    walk(tree);
    return nodes;
  }
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const button = label => render().find(n => n.type === 'button' && n.children.includes(label));
  const input = () => render().find(n => n.type === 'input' && n.props.type === 'password');
  return { render, calls, tick, button, input };
}

test('saved key can be tested without revealing it; Show button is removed', async () => {
  const ui = mount();
  ui.render(); await ui.tick();
  assert.equal(ui.button('测试').props.disabled, false);
  assert.equal(ui.button('保存并测试').props.disabled, true);
  assert.equal(ui.button('保存目录').props.disabled, true);
  assert.equal(ui.button('显示'), undefined);
  assert.equal(ui.input().props.value, '');
  ui.button('测试').props.onClick();
  assert.equal(ui.button('测试').props.disabled, true);
  await ui.tick();
  assert.deepEqual(ui.calls.at(-1), { action: 'testApiKey' });
  assert.equal(ui.button('测试').props.disabled, false);
  assert.ok(ui.render().some(n => n.children.includes('API Key 测试通过（未修改已保存的 Key）。')));
});

test('candidate tests send only the candidate and invalid input does not fall back', async () => {
  const ui = mount(); ui.render(); await ui.tick();
  ui.input().props.onChange({ target: { value: 'bad' } });
  ui.button('测试').props.onClick(); await ui.tick();
  assert.equal(ui.calls.length, 1);
  ui.input().props.onChange({ target: { value: 'b'.repeat(64) } });
  ui.button('测试').props.onClick(); await ui.tick();
  assert.deepEqual(ui.calls.at(-1), { action: 'testApiKey', token: 'b'.repeat(64) });
  assert.equal(ui.input().props.type, 'password');
});

test('missing credentials disable Test; failed tests display errors and release busy state', async () => {
  const empty = mount({ configured: false }); empty.render(); await empty.tick();
  assert.equal(empty.button('测试').props.disabled, true);
  const ui = mount({ failTest: true }); ui.render(); await ui.tick();
  ui.button('测试').props.onClick(); await ui.tick();
  assert.ok(ui.render().some(n => n.children.includes('Test failed')));
  assert.equal(ui.button('测试').props.disabled, false);
});

test('settings styles use current theme tokens and explicit disabled foreground/background', () => {
  assert.doesNotMatch(source, /--dsw-alias-(text-|bg-primary|bg-elevated|border-secondary)/);
  assert.match(source, /\.dmb-wrap \.dmb-btn:disabled\{background:var\(--dsw-alias-bg-layer-2[^}]+color:var\(--dsw-alias-label-secondary/);
  assert.match(source, /\.dmb-wrap \.dmb-btn\.primary\{background:var\(--dsw-alias-label-primary[^}]+color:var\(--dsw-alias-bg-base/);
});
