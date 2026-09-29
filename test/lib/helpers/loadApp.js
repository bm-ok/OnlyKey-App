/*
 * Load the App's page scripts into a Node vm context, with a permissive fake
 * DOM and a fake chrome.hid - no NW.js, no selenium, no USB.
 *
 * The scripts are run exactly as app.html runs them: dialog-manager.js, then
 * OnlyKeyWizard.js, then OnlyKeyComm.js, in ONE context, so their top-level
 * declarations share a scope the way <script> tags do. Then DOMContentLoaded
 * and load are fired. A vm context is also a separate V8 context from the one
 * the lib is required into - the same split NW.js makes between the page and
 * require()d modules - so a cross-context byte-container mistake fails here
 * the way it would in the App.
 *
 * The fake DOM answers any element id, form name or field with a stub that
 * records classList, innerHTML, value and dialog open/close, which is all the
 * device half reads or writes. It does not render anything.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_DIR = path.join(__dirname, '..', '..', '..', 'app');

function createDom() {
  const byId = new Map();
  const dialogs = new Set();
  const docListeners = {};

  function makeElement(id, tag = 'div') {
    const classes = new Set();
    const data = {
      id,
      name: id,
      tagName: String(tag).toUpperCase(),
      value: '',
      innerHTML: '',
      innerText: '',
      textContent: '',
      checked: false,
      disabled: false,
      open: false,
      files: null,
      dataset: {},
      style: {},
      onclick: null,
      onchange: null,
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c),
        toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      },
      showModal() { data.open = true; dialogs.add(proxy); },
      close() { data.open = false; },
      addEventListener() {},
      removeEventListener() {},
      setAttribute(k, v) { data[`attr:${k}`] = v; },
      removeAttribute(k) { delete data[`attr:${k}`]; },
      getAttribute(k) { return data[`attr:${k}`] === undefined ? null : data[`attr:${k}`]; },
      reset() {},
      focus() {},
      click() {},
      appendChild(c) { return c; },
      matches() { return false; },
      getElementsByClassName(c) { return [child(`.${c}`)]; },
      /* inputs are slot buttons, which the tests do not render; anything else
       * (the last-message <li>s and <span>) gets a few stubs */
      getElementsByTagName(t) { return t === 'input' ? [] : [0, 1, 2].map((i) => child(`${t}${i}`)); },
      getElementById(c) { return child(`#${c}`); },
      querySelector(q) { return child(q); },
      querySelectorAll() { return []; },
    };
    function child(key) {
      if (!(key in data)) data[key] = makeElement(key);
      return data[key];
    }
    const proxy = new Proxy(data, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
        target[prop] = makeElement(prop);
        return target[prop];
      },
    });
    return proxy;
  }

  const body = makeElement('body', 'body');
  const docData = {
    body,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement(id, /dialog/.test(id) ? 'dialog' : 'div'));
      return byId.get(id);
    },
    getElementsByTagName(tag) { return tag === 'dialog' ? [...dialogs] : []; },
    getElementsByName() { return []; },
    getElementsByClassName(c) { return [docData.getElementById(`.${c}`)]; },
    querySelector(q) { return docData.getElementById(q); },
    querySelectorAll() { return []; },
    createElement(tag) { return makeElement(tag, tag); },
    createTextNode(t) { return { textContent: t }; },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  const document = new Proxy(docData, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return target.getElementById(prop); /* document['yubiAuthForm'] and friends */
    },
  });

  return {
    document,
    byId: (id) => docData.getElementById(id),
    fire(type) { (docListeners[type] || []).forEach((fn) => fn({ type })); },
  };
}

/**
 * @param {object} fakeChrome  from createFakeChromeHid()
 * @param {object} [opts]
 * @param {boolean} [opts.wizard=true]  load the real OnlyKeyWizard.js
 * @returns {{ run: (code: string) => *, dom, logs, reloads: () => number }}
 */
function loadApp(fakeChrome, { wizard = true } = {}) {
  const dom = createDom();
  const logs = [];
  const winListeners = {};
  let reloads = 0;

  const quiet = (level) => (...args) => logs.push({ level, args });
  const sandbox = {
    console: {
      log: quiet('log'), info: quiet('info'), warn: quiet('warn'),
      error: quiet('error'), dir: quiet('dir'),
    },
    document: dom.document,
    chrome: { hid: fakeChrome.hid, runtime: fakeChrome.runtime },
    nw: { Shell: { openExternal() {} } }, /* desktopApp = true, as in NW.js */
    setTimeout, clearTimeout, setInterval, clearInterval,
    atob: (b64) => Buffer.from(b64, 'base64').toString('latin1'),
    btoa: (s) => Buffer.from(s, 'latin1').toString('base64'),
    alert: quiet('alert'),
    confirm: () => false,
    location: { reload() { reloads += 1; }, href: '' },
    localStorage: {},
    Blob: class Blob {},
    saveAs() {},
    FileReader: class FileReader {
      readAsText(file) {
        setTimeout(() => this.onload({ target: { result: file.text } }), 0);
      }
    },
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener() {},
    require(name) {
      if (name === './scripts/onlyKey/libPipe.js') {
        return require(path.join(APP_DIR, 'scripts', 'onlyKey', 'libPipe.js'));
      }
      if (name === './scripts/userPreferences.js') return { autoUpdateFW: false };
      if (name === 'request') return { get() { throw new Error('no network in tests'); } };
      return require(name);
    },
  };
  sandbox.window = sandbox;
  sandbox.window.location = sandbox.location;
  sandbox.window.confirm = sandbox.confirm;
  vm.createContext(sandbox);

  const load = (rel) => {
    const file = path.join(APP_DIR, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  };

  load('scripts/dialog-manager.js');
  if (wizard) load('scripts/onlyKey/OnlyKeyWizard.js');
  load('scripts/onlyKey/OnlyKeyComm.js');

  dom.fire('DOMContentLoaded');
  (winListeners.load || []).forEach((fn) => fn({ type: 'load' }));

  return {
    run: (code) => vm.runInContext(code, sandbox),
    sandbox,
    dom,
    logs,
    reloads: () => reloads,
    errors: () => logs.filter((l) => l.level === 'error'),
  };
}

/** Poll until `fn()` is truthy. */
async function until(fn, { timeoutMs = 5000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

module.exports = { loadApp, createDom, until };
