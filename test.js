'use strict';
// Black-box tests for index.html: runs the page's inline scripts in a VM
// sandbox with a minimal DOM/localStorage stub and exercises per-story state
// rules, toggles, and theme. The page is fully offline; fetch is stubbed to
// reject so the tests fail loudly if it's ever called.
// Run: node test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const source = scripts.join('\n;\n');

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log('ok -', name);
  } catch (e) {
    failures++;
    console.log('FAIL -', name, '\n   ', e.message);
  }
};
const testAsync = (name, fn) => Promise.resolve().then(fn).then(
  () => console.log('ok -', name),
  (e) => { failures++; console.log('FAIL -', name, '\n   ', e.message); }
);

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.attrs = {};
    this._text = '';
    this._html = '';
    this.checked = false;
    this.value = '';
    this.href = '';
    this.rel = '';
    this.title = '';
    this.classList = {
      add: (...cs) => cs.forEach((c) => this.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => this.classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !this.classes.has(c) : !!force;
        on ? this.classes.add(c) : this.classes.delete(c);
        return on;
      },
      contains: (c) => this.classes.has(c),
    };
    this.classes = new Set();
  }
  get textContent() { return this._text; }
  set textContent(v) {
    this._text = v;
    for (const c of [...this.children]) this.removeChild(c);
    if (v !== '') this.appendChild(docStub.createTextNode(v));
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = v;
    for (const c of [...this.children]) this.removeChild(c);
    if (v !== '') this.appendChild(docStub.createTextNode(v));
  }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(v.split(/\s+/).filter(Boolean)); }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  before(n) {
    const p = this.parentNode;
    const i = p.children.indexOf(this);
    p.children.splice(i, 0, n);
    n.parentNode = p;
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  fire(t, ev = {}) {
    ev.preventDefault ||= () => {};
    ev.stopPropagation ||= () => {};
    for (const fn of this.listeners[t] || []) fn.call(this, ev);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
}

const docStub = {
  createTextNode: (t) => Object.assign(new El('#text'), { _text: String(t) }),
};

function makeStore(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() { return m.size; },
    key: (i) => [...m.keys()][i],
    _map: m,
  };
}

const byId = () => new Map();
function runApp(storeSeed) {
  const store = makeStore(storeSeed);
  const els = byId();
  const ids = ['list', 'f', 'count', 'hideReadLink', 'hideUnreadLink', 'hideLikedLink', 'themeLink'];
  for (const id of ids) els.set(id, new El(id === 'f' ? 'form' : id === 'list' ? 'ul' : 'div'));
  els.get('count').value = '150';
  const doc = {
    body: new El('body'),
    createElement: (t) => new El(t),
    getElementById: (id) => els.get(id) || null,
  };
  const sandbox = {
    localStorage: store,
    document: doc,
    console,
    setTimeout,
    fetch: () => Promise.reject(new Error('unexpected fetch')),
    Math, Date, JSON, Object, Array, Set, String, Number, Error, Promise, isNaN, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'hn-wiki-inline.js' });
  return new Promise((resolve) => setTimeout(() => resolve({ els, store }), 0));
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const rowOf = (li) => li.children[0];
const rowKids = (li) => rowOf(li).children; // [cb, qbtn, pts, (year), title]
const storyId = (li) => rowKids(li)[2].href.split('id=')[1];

(async () => {
  // --- Built-in wikipedia render ---
  const rw = await runApp();
  test('builtin: renders 150 wikipedia rows from embedded data', () => {
    const list = rw.els.get('list');
    assert.strictEqual(list.children.length, 150);
  });

  // --- Count input drives list length ---
  const rc = await runApp();
  rc.els.get('count').value = '10';
  rc.els.get('count').fire('change');
  test('count: changing the count input re-renders', () => {
    assert.strictEqual(rc.els.get('list').children.length, 10);
  });

  // --- Interactions on the built-in list ---
  const ri = await runApp();
  const list = ri.els.get('list');
  const store = ri.store;
  const li0 = list.children[0];
  const id0 = storyId(li0);
  const cb0 = () => rowKids(li0)[0];
  const qbtn0 = () => rowKids(li0)[1];
  const link0 = () => rowKids(li0)[rowKids(li0).length - 1].children[0];
  const state = () => {
    const s = JSON.parse(store.getItem('hn-state') || '{}');
    return { read: s.read || {}, liked: s.liked || {}, clicked: s.clicked || {} };
  };

  test('click (left) marks clicked', () => {
    assert.strictEqual(state().clicked[id0], undefined);
    link0().fire('click');
    assert.strictEqual(state().clicked[id0], true);
    assert.ok(li0.classList.contains('clicked'));
  });

  test('middle-click (button 1) marks clicked', () => {
    const li1 = list.children[1];
    const id1 = storyId(li1);
    rowKids(li1)[rowKids(li1).length - 1].children[0].fire('auxclick', { button: 1 });
    assert.strictEqual(JSON.parse(store.getItem('hn-state')).clicked[id1], true);
    assert.ok(li1.classList.contains('clicked'));
  });

  test('auxclick with button 2 does not mark clicked', () => {
    const li2 = list.children[2];
    const id2 = storyId(li2);
    rowKids(li2)[rowKids(li2).length - 1].children[0].fire('auxclick', { button: 2 });
    assert.strictEqual(state().clicked[id2], undefined);
  });

  test('checkbox marks read and clears clicked', () => {
    cb0().checked = true;
    cb0().fire('change');
    assert.strictEqual(state().read[id0], true);
    assert.strictEqual(state().clicked[id0], undefined);
    assert.ok(li0.classList.contains('read'));
    assert.ok(!li0.classList.contains('clicked'));
  });

  test('un-checking read leaves clicked absent', () => {
    cb0().checked = false;
    cb0().fire('change');
    assert.strictEqual(state().read[id0], undefined);
    assert.strictEqual(state().clicked[id0], undefined);
  });

  test('like marks liked + read and clears clicked', () => {
    qbtn0().fire('click');
    const st = state();
    assert.strictEqual(st.liked[id0], true);
    assert.strictEqual(st.read[id0], true);
    assert.strictEqual(st.clicked[id0], undefined);
    assert.strictEqual(qbtn0().getAttribute('aria-pressed'), 'true');
    assert.ok(li0.classList.contains('quality'));
    assert.ok(li0.classList.contains('read'));
    assert.strictEqual(cb0().checked, true);
  });

  test('unlike keeps read (behavior preserved)', () => {
    qbtn0().fire('click');
    const st = state();
    assert.strictEqual(st.liked[id0], undefined);
    assert.strictEqual(st.read[id0], true);
    assert.ok(!li0.classList.contains('quality'));
    assert.ok(li0.classList.contains('read'));
  });

  test('click does not mark clicked when already read', () => {
    const li3 = list.children[3];
    const id3 = storyId(li3);
    const cb3 = rowKids(li3)[0];
    cb3.checked = true;
    cb3.fire('change');
    rowKids(li3)[rowKids(li3).length - 1].children[0].fire('click');
    assert.strictEqual(JSON.parse(store.getItem('hn-state')).clicked[id3], undefined);
  });

  test('click does not mark clicked when liked', () => {
    const li4 = list.children[4];
    const id4 = storyId(li4);
    const q4 = rowKids(li4)[1];
    q4.fire('click');
    assert.strictEqual(JSON.parse(store.getItem('hn-state')).clicked[id4], undefined);
  });

  test('hide read toggle: liked rows survive, read rows hidden', () => {
    const hideLink = ri.els.get('hideReadLink');
    hideLink.fire('click');
    assert.strictEqual(hideLink.textContent, '[show read]');
    const ids = [...list.children.map(storyId)];
    assert.ok(!ids.includes(id0), 'read row id0 hidden');
    const likedRow = list.children.find((li) => {
      const q = rowKids(li)[1];
      return q && q.getAttribute('aria-pressed') === 'true';
    });
    assert.ok(likedRow, 'liked row still visible under [hide read]');
    hideLink.fire('click');
    assert.strictEqual(hideLink.textContent, '[hide read]');
  });

  test('like-implies-read triggers rerender when hide read is on', async () => {
    ri.els.get('hideReadLink').fire('click');
    const before = new Set([...list.children.map(storyId)]);
    const li5 = list.children[5];
    const id5 = storyId(li5);
    assert.ok(!before.has(id0), 'sanity: read row hidden');
    rowKids(li5)[1].fire('click');
    const after = new Set([...list.children.map(storyId)]);
    assert.ok(after.has(id5), 'liked row still visible');
    assert.strictEqual(JSON.parse(store.getItem('hn-state')).read[id5], true);
    ri.els.get('hideReadLink').fire('click');
  });

  test('theme toggle persists', () => {
    const tl = ri.els.get('themeLink');
    tl.fire('click');
    assert.strictEqual(tl.textContent, '[dark]');
    assert.strictEqual(store.getItem('hn-theme'), 'light');
    tl.fire('click');
    assert.strictEqual(tl.textContent, '[light]');
    assert.strictEqual(store.getItem('hn-theme'), 'dark');
  });

  // --- Seeded state drives row classes after load ---
  const r3 = await runApp({
    'hn-state': JSON.stringify({ read: { [id0]: true }, liked: {}, clicked: { [id0]: true } }),
  });
  test('seeded flags drive row classes', () => {
    const li = r3.els.get('list').children[0];
    assert.ok(li.classList.contains('read'));
    assert.ok(li.classList.contains('clicked'));
  });

  console.log(failures ? `\n${failures} failure(s)` : '\nall tests passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
