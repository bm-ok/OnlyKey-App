/*
 * libPipe.js - the seam between the classic App and node-onlykey-lib.
 *
 * Two things live here, and nothing else:
 *
 *   1. createChromeHidPipe() - a byte pipe over chrome.hid, in the shape the
 *      lib's transport/usb plugin takes (node-onlykey-lib
 *      src/transport/pipeTransport.js, "THE PIPE CONTRACT"):
 *
 *        start()                 connect to the vendor collection
 *        stop()                  disconnect it
 *        isRunning()
 *        write(iface, bytes)     one 64-byte report, report ID 0
 *        on('stream', listener)  {iface, dir, bytes}, both directions
 *
 *   2. composeLibStack() - the lib's plugins built over that pipe with Rectify,
 *      the way node-onlykey-lib cli/desktop.js composes them for node-hid:
 *      [host, transport/usb, session, device, okcrypto], transport opened.
 *
 * WHY A MODULE AND NOT MORE PAGE SCRIPT. NW.js runs require()d modules in the
 * NODE context and the <script> tags in the DOM context. Those are different
 * V8 contexts with different globals, so:
 *
 *   - `chrome` does not exist here. The page hands in its `chromeHid` wrapper
 *     (OnlyKeyComm.js) and a `lastError()` reader, and this file never
 *     touches the chrome object itself. That is also what keeps the selenium
 *     mock hooks (chromeHid.mockDeviceAdded / mockResponse / _sent) working:
 *     every call still goes through the wrapper they patch.
 *   - `instanceof Uint8Array` / `instanceof ArrayBuffer` are FALSE across the
 *     two contexts. So nothing here tests a byte container with instanceof;
 *     incoming data is duck-typed, and the ArrayBuffer given to chrome.hid.send
 *     is made by the page (`toArrayBuffer`) because the extension binding
 *     type-checks it in the page's context.
 *
 * The lib is CommonJS and is required straight from node_modules - there is no
 * bundler in this App (app.html loads plain scripts), and NW's require() in a
 * page already loads userPreferences, request and sshpk the same way.
 */
'use strict';

const path = require('path');

/* node-onlykey-lib's own constants, not restated: which interface the vendor
 * reports are on, and which way a stream event is going. */
const { IFACE, DIR } = require('node-onlykey-lib/transport');

/** OKFWUPDATE. The one message the App never paced (see `paceMs`). */
const OKFWUPDATE = 0xf4;

const REPORT_SIZE = 64;

/**
 * Any byte container -> a Uint8Array made in THIS context.
 *
 * chrome.hid.receive hands over an ArrayBuffer from the page's context and the
 * selenium mock hands over one rebuilt from an executeScript object, so both
 * are accepted by shape: something with a byteLength and no length is a buffer.
 */
function toBytes(data) {
  if (data && typeof data.length !== 'number' && typeof data.byteLength === 'number') {
    return new Uint8Array(data.slice(0));
  }
  return Uint8Array.from(data || []);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pipe over chrome.hid for ONE device collection.
 *
 * @param {object} opts
 * @param {object} opts.chromeHid  the page's chromeHid wrapper (connect,
 *   disconnect, send, receive) - never chrome.hid directly, see above
 * @param {*} opts.deviceId        the collection the App's hot-plug picked
 *   (usage page 0xFFAB on firmware since beta 8, OnlyKeyComm.js onDeviceAdded)
 * @param {() => *} [opts.lastError]  reads chrome.runtime.lastError in the page
 * @param {(bytes: number[]) => ArrayBuffer} [opts.toArrayBuffer]  builds the
 *   buffer chrome.hid.send takes, in the page's context
 * @param {number} [opts.paceMs]   gap after each write, see below
 * @param {(err: *) => void} [opts.onReceiveError]  the receive loop stopped
 * @param {object} [opts.log]
 */
function createChromeHidPipe({
  chromeHid,
  deviceId,
  lastError = () => null,
  toArrayBuffer = (bytes) => Uint8Array.from(bytes).buffer,
  paceMs = 100,
  onReceiveError = null,
  log = console,
} = {}) {
  if (!chromeHid) throw new TypeError('createChromeHidPipe needs the page\'s chromeHid wrapper');

  const listeners = new Set();
  let connectionId = null;
  let running = false;

  function emit(event) {
    for (const listener of [...listeners]) {
      /*
       * One listener throwing must not starve the others or kill the loop: the
       * transport's demultiplexer and the App's monitor both hang off this, and
       * a UI bug in the monitor would otherwise stop the lib hearing replies.
       */
      try { listener(event); } catch (err) { log.error('libPipe listener failed:', err); }
    }
  }

  /*
   * THE RECEIVE LOOP. chrome.hid.receive is one-shot: it answers the next
   * report and then nothing until it is called again. The old App called it
   * from wherever it happened to want a reply (pollForInput, re-armed by each
   * handler), so a report that arrived while nobody had asked sat in Chrome's
   * queue and was later handed to whichever caller asked next - the root of
   * the "unexpected message" handling all over OnlyKeyComm.js.
   *
   * The pipe contract is a STREAM, so this re-arms itself for as long as the
   * pipe runs and every report is emitted as it arrives. It is now the only
   * reader: two readers on one connection would each take every other report.
   *
   * RE-ARMED BEFORE EMITTING. The selenium mock keeps exactly one pending
   * receive and throws if a response is injected while none is pending; arming
   * first means a listener that reacts synchronously (the mock answering a
   * write inside send) always finds one.
   */
  function arm() {
    if (!running) return;
    const conn = connectionId;
    try {
      chromeHid.receive(conn, (reportId, data) => {
        const err = lastError();
        if (!running || conn !== connectionId) return;
        if (err) {
          /*
           * Stopped, not retried. A receive error is what an unplugged key
           * produces, and re-arming would spin on it; the hot-plug handler
           * (onDeviceRemoved) owns what happens next, as it always did.
           */
          running = false;
          log.error('libPipe receive failed:', err);
          if (onReceiveError) onReceiveError(err);
          return;
        }
        arm();
        emit({ iface: IFACE.VENDOR, dir: DIR.OUT, bytes: toBytes(data) });
      });
    } catch (err) {
      running = false;
      log.error('libPipe could not arm a receive:', err);
      if (onReceiveError) onReceiveError(err);
    }
  }

  return {
    start() {
      if (running) return Promise.resolve({ started: true, connectionId });
      return new Promise((resolve, reject) => {
        chromeHid.connect(deviceId, (connectInfo) => {
          const err = lastError();
          if (err || !connectInfo) {
            reject(new Error(`could not connect to OnlyKey device ${deviceId}: ${
              (err && err.message) || 'no connection info'}`));
            return;
          }
          connectionId = connectInfo.connectionId;
          running = true;
          arm();
          resolve({ started: true, connectionId });
        });
      });
    },

    stop() {
      const conn = connectionId;
      running = false;
      if (conn === null) return Promise.resolve();
      return new Promise((resolve) => {
        /*
         * Resolved whether or not Chrome complains. A key that has been pulled
         * out cannot be disconnected cleanly, and the old onDeviceRemoved
         * returned early on that error and left the UI saying "connected".
         */
        try {
          chromeHid.disconnect(conn, () => {
            const err = lastError();
            if (err) log.warn('libPipe disconnect:', err);
            resolve();
          });
        } catch (err) {
          log.warn('libPipe disconnect threw:', err);
          resolve();
        }
      });
    },

    isRunning() {
      return running;
    },

    write(iface, bytes) {
      if (iface !== IFACE.VENDOR) {
        return Promise.reject(new Error(
          `the App opens only the vendor collection (interface ${IFACE.VENDOR}); `
          + `interface ${iface} is not open`));
      }
      if (!running) return Promise.reject(new Error('the OnlyKey is not connected'));

      const frame = toBytes(bytes);
      if (frame.length !== REPORT_SIZE) {
        return Promise.reject(new Error(`a vendor report is ${REPORT_SIZE} bytes, got ${frame.length}`));
      }

      return new Promise((resolve, reject) => {
        /*
         * REPORT ID 0, as its own argument. chrome.hid takes the report ID
         * separately from the data, so unlike hidapi (cli/transport-hid.js)
         * nothing is prepended - the 64 bytes go as they are.
         */
        chromeHid.send(connectionId, 0, toArrayBuffer(Array.from(frame)), () => {
          const err = lastError();
          if (err) {
            reject(new Error(`chrome.hid.send failed: ${err.message || err}`));
            return;
          }
          /*
           * THE APP'S PACING, kept. sendMessage waited 100 ms after every send
           * except OKFWUPDATE before calling back (OnlyKeyComm.js 6.0.0,
           * sendMessage), so every sequence it ever ran - RSA chunks, restore
           * packets, slot fields - went out at most ten a second. The lib's
           * node-hid pipe does not pace, and these sequences have only ever
           * been proven on this App at this rate; keeping it makes the lib run
           * at the timing the firmware has seen from this App for years.
           * Firmware packets are acknowledged one by one ("RECEIVED
           * OKFWUPDATE"), which is why they were exempt and still are.
           */
          const pace = frame[4] === OKFWUPDATE ? 0 : paceMs;
          (pace > 0 ? sleep(pace) : Promise.resolve()).then(() => resolve(REPORT_SIZE));
        });
        /*
         * Echoed as dir IN. A USB pipe sees inbound reports only; the transport
         * filters on direction, so the host echoes its own writes to make `dir`
         * mean the same on every pipe (pipeTransport.js, cli/transport-hid.js).
         */
        emit({ iface, dir: DIR.IN, bytes: frame });
      });
    },

    on(event, listener) {
      if (event !== 'stream') throw new Error(`the chrome.hid pipe has no "${event}" event`);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The chrome.hid connection id once started, else null. */
    get connectionId() { return connectionId; },
  };
}

/**
 * Rectify, resolved FROM THE LIB'S OWN TREE.
 *
 * It is the lib's dependency, not the App's. npm hoists it to the top-level
 * node_modules today, but a nested install would put it under
 * node_modules/node-onlykey-lib/node_modules, and a bare require from this
 * directory would then miss it. Resolving from the lib's package directory
 * finds it in either layout.
 */
function loadRectify() {
  const libDir = path.dirname(require.resolve('node-onlykey-lib/package.json'));
  return require(require.resolve('@bmatusiak/rectify', { paths: [libDir] }));
}

/**
 * The lib stack over a pipe, started and with the transport OPEN.
 *
 * The same five plugins cli/desktop.js composes, in the same order - it is the
 * full stack ok-rn runs, and composing it here rather than a subset means the
 * App runs the code the other GUIs ship. okcrypto is unused by the classic UI
 * today; it is composed so the stack is the standard one, not a fork of it.
 *
 * Nothing opens the transport on its own (the host decides when to take the
 * device), so this does, and tears the app down again if that fails - a
 * half-built app still holds the pipe's listeners.
 *
 * @param {object} opts
 * @param {object} opts.pipe      a pipe (createChromeHidPipe, or a test fake)
 * @param {object} [opts.config]  further plugins.config
 * @returns {Promise<object>} the Rectify app; app.services.{device,transport,...}
 */
function composeLibStack({ pipe, config = {} } = {}) {
  const Rectify = loadRectify();
  const plugins = [
    require('node-onlykey-lib/plugins/host'),
    require('node-onlykey-lib/plugins/transport/usb'),
    require('node-onlykey-lib/plugins/session'),
    require('node-onlykey-lib/plugins/device'),
    require('node-onlykey-lib/plugins/okcrypto'),
  ];
  plugins.config = {
    ...config,
    transport: { ...(config.transport || {}), pipe },
  };

  return new Promise((resolve, reject) => {
    const app = Rectify.build(plugins, (err, started) => (err ? reject(err) : resolve(started)));
    app.start();
  }).then(async (app) => {
    try {
      await app.services.transport.open();
    } catch (err) {
      await app.destroy().catch(() => {});
      throw err;
    }
    return app;
  });
}

/* ------------------------------------------------------------------------ *
 * Tables the facade in OnlyKeyComm.js maps through. They are here, not in the
 * page script, so the mocha tests can check them without a DOM.
 * ------------------------------------------------------------------------ */

/**
 * App slot field name (OnlyKey.messageFields) -> lib slotConfig field name.
 * The App's wizard passes the left-hand names to setSlot; the lib's setSlot
 * takes an object keyed by the right-hand ones (src/device/slotConfig.js).
 */
const SLOT_FIELD = {
  LABEL: 'label',
  URL: 'url',
  NEXTKEY4: 'nextKey4',
  NEXTKEY1: 'nextKey1',
  DELAY1: 'delay1',
  USERNAME: 'username',
  NEXTKEY5: 'nextKey5',
  NEXTKEY2: 'nextKey2',
  DELAY2: 'delay2',
  PASSWORD: 'password',
  NEXTKEY3: 'nextKey3',
  DELAY3: 'delay3',
  TFATYPE: 'tfaType',
  TFAUSERNAME: 'totpKey',
  YUBIAUTH: 'yubikey',
  TYPESPEED: 'typeSpeed',
};

/**
 * App preference setter field -> lib PREFERENCES name
 * (plugins/device/index.js PREFERENCES). All are OKSETSLOT on slot 'XX'.
 * SECPROFILEMODE is deliberately ABSENT - see LIB-PORT.md, lib gaps.
 */
const PREFERENCE = {
  LOCKOUT: 'lockout',
  WIPEMODE: 'wipeMode',
  BACKUPKEYMODE: 'backupKeyMode',
  derivedchallengeMode: 'derivedChallengeMode',
  storedchallengeMode: 'storedChallengeMode',
  webAgentDeriveMode: 'webAgentDeriveMode',
  webcryptPolicy: 'webcryptPolicy',
  hmacchallengeMode: 'hmacChallengeMode',
  modkeyMode: 'modKeyMode',
  TYPESPEED: 'typeSpeed',
  LEDBRIGHTNESS: 'ledBrightness',
  LOCKBUTTON: 'lockButton',
  KBDLAYOUT: 'keyboardLayout',
};

/** The App's PIN message ids -> the lib's PIN kinds (src/protocol/msg.js PIN_KIND). */
const PIN_KIND = {
  OKSETPIN: 'primary',
  OKSETPIN2: 'secondary',
  OKSETSDPIN: 'selfDestruct',
};

/**
 * The four SENDING steps of the classic PIN bracket, in the order the firmware
 * walks them (libraries okcore.cpp set_primary_pin: `pin_set` 0 -> 1 -> 2 ->
 * 3 -> 0). The lib's pinStep() runs one of these by label
 * (src/device/pin.js PIN_SEQUENCE); the two `digits` steps and `committed`
 * send nothing and are the person's, and the firmware's, respectively.
 *
 * Index = how many messages of this kind the firmware has taken since it was
 * last at pin_set 0, which is what the facade counts.
 */
const PIN_STEPS = ['armed', 'stored', 'confirming', 'matched'];

/**
 * The App's in-band escapes. sendMessage turned a typed `\xNN` into the byte
 * NN before sending (OnlyKeyComm.js 6.0.0), so a user could put a control
 * character into a slot from a text box. That is an App input convention, not
 * protocol, so the lib does not do it and the facade does, before the lib sees
 * the string. Non-Latin-1 is refused as the App refused it: the lib's encoder
 * would mask it to a different byte instead.
 */
function unescapeAppText(text) {
  const out = String(text).replace(/\\x([a-fA-F0-9]{2})/g,
    (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  for (let i = 0; i < out.length; i++) {
    if (out.charCodeAt(i) > 255) throw new Error('I am not smart enough to decode non-ASCII data.');
  }
  return out;
}

/** A value the wizard hands setSlot, as the lib's slotConfig wants it. */
function slotValue(appField, value) {
  if (Array.isArray(value)) return value.join('');   // TFAUSERNAME / YUBIAUTH: hex pairs
  if (typeof value === 'number') return value;       // TYPESPEED
  return unescapeAppText(value);
}

/** Hex pairs, or a hex string, to a plain byte array. */
function hexToByteArray(hex) {
  const clean = (Array.isArray(hex) ? hex.join('') : String(hex)).replace(/\s/g, '');
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.substr(i, 2), 16));
  return out;
}

module.exports = {
  createChromeHidPipe,
  composeLibStack,
  loadRectify,
  toBytes,
  IFACE,
  DIR,
  SLOT_FIELD,
  PREFERENCE,
  PIN_KIND,
  PIN_STEPS,
  unescapeAppText,
  slotValue,
  hexToByteArray,
  /* The lib's modules the facade builds with, from the lib's public exports. */
  lib: {
    protocol: require('node-onlykey-lib/protocol'),
  },
};
