/*
 * A scripted OnlyKey behind a fake chrome.hid - for the lib-port tests only.
 *
 * Nothing here opens USB or HID. `createFakeChromeHid()` stands in for the
 * chrome.hid extension API (connect / disconnect / receive / send, and the
 * onDeviceAdded / onDeviceRemoved events), and `FakeOnlyKey` answers the
 * frames written to it the way the firmware's vendor handlers do, using the
 * firmware's own wording (libraries/onlykey/okcore.cpp): enough to drive the
 * App's facade through connect, labels, slot writes, the PIN bracket, key
 * loads, backup passphrase and - ONLY HERE, against this model - the firmware
 * load request and a bootloader load.
 *
 * Replies are queued and handed to chrome.hid.receive the way Chrome does:
 * a report that arrives while no receive is pending waits for the next one.
 */
'use strict';

const REPORT = 64;
const HEADER = [0xff, 0xff, 0xff, 0xff];

const MSG = {
  OKSETPIN: 0xe1, OKSETSDPIN: 0xe2, OKSETPIN2: 0xe3, OKSETTIME: 0xe4,
  OKGETLABELS: 0xe5, OKSETSLOT: 0xe6, OKWIPESLOT: 0xe7,
  OKWIPEPRIV: 0xee, OKSETPRIV: 0xef, OKRESTORE: 0xf1, OKFWUPDATE: 0xf4,
};

function textReport(text) {
  const out = new Uint8Array(REPORT);
  for (let i = 0; i < text.length && i < REPORT; i++) out[i] = text.charCodeAt(i);
  return out;
}

class FakeOnlyKey {
  constructor({
    model = 'classic', state = 'unlocked', version = 'v3.0.4-prodc', configMode = false,
  } = {}) {
    this.model = model;
    this.state = state;              // uninitialized | locked | unlocked | bootloader
    this.version = version;
    this.configMode = configMode;
    const slots = model === 'duo' ? 24 : 12;
    this.labels = Array.from({ length: slots }, (_, i) => (i === 0 ? 'FooLabel' : ''));
    this.received = [];              // every frame written to the device
    this.slotWrites = [];            // {slot, field, data}
    this.keys = {};                  // slot -> {type, bytes}
    this.restored = [];
    this.pinSet = { 0xe1: 0, 0xe2: 0, 0xe3: 0 };
    this.guess = '';
    this.stored = null;
    this.pins = {};                  // kind -> committed PIN
    this.pendingKey = null;
    this.firmwareBlocks = 0;         // how many blocks a bootloader load has
    this.firmwareDone = 0;
    this.out = null;                 // set by the fake chrome.hid
  }

  status() {
    if (this.state === 'uninitialized') return `UNINITIALIZED${this.version}`;
    if (this.state === 'locked') return this.model === 'duo' ? 'INITIALIZED-D' : 'INITIALIZED';
    if (this.state === 'bootloader') return 'BOOTLOADER';
    return `UNLOCKED${this.version}`;
  }

  say(text) { this.out(textReport(text)); }
  sayBytes(bytes) { const r = new Uint8Array(REPORT); r.set(bytes.slice(0, REPORT)); this.out(r); }

  /** The once-a-second status of a locked key; tests call it by hand. */
  broadcast() { this.say(this.status()); }

  /** The person pressing the key's buttons during PIN entry. */
  press(digits) { this.guess += digits; }

  receive(frame) {
    this.received.push(frame);
    if (!HEADER.every((b, i) => frame[i] === b)) return;
    const id = frame[4];
    const slot = frame[5];
    const field = frame[6];

    switch (id) {
      case MSG.OKSETTIME:
        return this.say(this.status());

      case MSG.OKGETLABELS:
        if (this.state === 'locked') return this.say('Error device locked');
        this.labels.forEach((label, i) => {
          const n = i + 1;
          const code = n <= 9 ? n : n + 6;
          this.sayBytes([code, 0x7c, ...Array.from(label, (c) => c.charCodeAt(0))]);
        });
        return undefined;

      case MSG.OKSETSLOT: {
        if (slot === 0 && field === 23) return undefined; // 2nd profile mode: silent (okcore.cpp case 23)
        const data = Array.from(frame.slice(7));
        this.slotWrites.push({ slot, field, data });
        const names = { 1: 'Label', 5: 'Password', 6: 'Additional Character3', 2: 'Username', 11: 'idle timeout', 13: 'typespeed', 24: 'LED brightness' };
        return this.say(`Successfully set ${names[field] || `field ${field}`}`);
      }

      case MSG.OKWIPESLOT:
        if (slot === 0 && field === 10) return undefined; // global Yubico wipe: silent
        this.say('Successfully wiped Label');
        return this.say('Successfully wiped URL');

      case MSG.OKSETPIN:
      case MSG.OKSETSDPIN:
      case MSG.OKSETPIN2:
        if (this.model === 'duo') return this.duoPin(frame);
        return this.classicPin(id);

      case MSG.OKSETPRIV: {
        if (this.state === 'unlocked' && !this.configMode) return this.say('Error not in config mode');
        const data = Array.from(frame.slice(7));
        if (slot === 131) return this.say('Successfully set Backup Passphrase');
        if (slot >= 101 && slot <= 116) {
          this.keys[slot] = { type: field, bytes: data.slice(0, 32) };
          return this.say('Successfully set ECC Key');
        }
        const size = (field & 0x0f) * 128;
        if (!this.pendingKey) this.pendingKey = { slot, type: field, bytes: [] };
        const want = size - this.pendingKey.bytes.length;
        this.pendingKey.bytes.push(...data.slice(0, Math.min(57, want)));
        if (this.pendingKey.bytes.length >= size) {
          this.keys[slot] = this.pendingKey;
          this.pendingKey = null;
          return this.say('Successfully set RSA Key');
        }
        return undefined;
      }

      case MSG.OKWIPEPRIV:
        delete this.keys[slot];
        return this.say(slot > 100 ? 'Successfully wiped ECC Private Key' : 'Successfully wiped RSA Private Key');

      case MSG.OKRESTORE:
        this.restored.push(Array.from(frame.slice(5)));
        return undefined;

      case MSG.OKFWUPDATE:
        return this.firmware(frame);

      default:
        return undefined;
    }
  }

  classicPin(id) {
    const step = this.pinSet[id];
    const sd = id === MSG.OKSETSDPIN;
    switch (step) {
      case 0:
        this.guess = '';
        this.pinSet[id] = 1;
        return this.say(sd ? 'OnlyKey is ready, enter your self-destruct PIN' : 'OnlyKey is ready, enter your PIN');
      case 1:
        this.pinSet[id] = 2;
        if (this.guess.length > 6 && this.guess.length < 11) {
          this.stored = this.guess;
          this.guess = '';
          return this.say('Successful PIN entry');
        }
        this.guess = '';
        this.pinSet[id] = 0;
        return this.say('Error PIN is not between 7 - 10 digits');
      case 2:
        this.pinSet[id] = 3;
        return this.say('OnlyKey is ready, re-enter your PIN to confirm');
      default: {
        this.pinSet[id] = 0;
        const ok = this.guess.length >= 7 && this.guess.length < 11 && this.guess === this.stored;
        const said = this.guess;
        this.guess = '';
        if (!ok) {
          return this.say(said.length >= 7 && said.length < 11
            ? "Error PINs Don't Match" : 'Error PIN is not between 7 - 10 digits');
        }
        this.pins[id] = said;
        return this.say('Successfully set PIN');
      }
    }
  }

  duoPin(frame) {
    const body = Array.from(frame.slice(5));
    if (body[0] === 0xff) {
      this.pins.duo = body.slice(1, 17).filter((b) => b).map((b) => String.fromCharCode(b)).join('');
      return this.say('Successfully set PIN');
    }
    const tried = body.filter((b) => b).map((b) => String.fromCharCode(b)).join('');
    if (this.state === 'locked' && tried === this.pins.duo) {
      this.state = 'unlocked';
      return this.say(this.status());
    }
    return this.say(this.status());
  }

  firmware(frame) {
    if (this.state !== 'bootloader') {
      if (!this.configMode) return this.say('Error not in config mode');
      return this.say('SUCCESSFULL FW LOAD REQUEST, REBOOTING...');
    }
    this.say('RECEIVED OKFWUPDATE');
    const header = frame[5];
    if (header === 0xff) return undefined;
    this.firmwareDone += 1;
    return this.say(this.firmwareDone >= this.firmwareBlocks ? 'SUCCESSFULLY LOADED FW' : 'NEXT BLOCK');
  }
}

/**
 * chrome.hid, faked. `device` answers what is sent to it; `lastError` is the
 * chrome.runtime.lastError a test may set to simulate a failure.
 */
function createFakeChromeHid(device) {
  const queue = [];
  let pending = null;
  let lastError = null;
  const added = [];
  const removed = [];
  const sent = [];
  let connections = 0;
  let open = null;

  function flush() {
    while (pending && queue.length) {
      const cb = pending;
      pending = null;
      const data = queue.shift();
      cb(0, data.buffer);
    }
  }

  if (device) {
    device.out = (report) => {
      queue.push(report);
      setTimeout(flush, 1);
    };
  }

  const hid = {
    connect(deviceId, cb) {
      connections += 1;
      open = `conn-${connections}`;
      setTimeout(() => cb({ connectionId: open }), 0);
    },
    disconnect(conn, cb) {
      /* Chrome ends a pending receive on disconnect; it is dropped here. */
      if (conn === open) { open = null; pending = null; queue.length = 0; }
      setTimeout(() => cb(), 0);
    },
    getDevices(opts, cb) { setTimeout(() => cb([]), 0); },
    receive(conn, cb) {
      if (pending) throw new Error('There must not be multiple pending receives.');
      pending = cb;
      setTimeout(flush, 0);
    },
    send(conn, reportId, data, cb) {
      const bytes = new Uint8Array(data.slice(0));
      sent.push({ conn, reportId, bytes });
      setTimeout(() => {
        cb();
        if (device && conn === open) device.receive(bytes);
      }, 0);
    },
    onDeviceAdded: { addListener(fn) { added.push(fn); } },
    onDeviceRemoved: { addListener(fn) { removed.push(fn); } },
  };

  return {
    hid,
    runtime: { get lastError() { return lastError; } },
    setLastError(err) { lastError = err; },
    sent,
    get pendingReceive() { return pending; },
    get openConnection() { return open; },
    plugIn(info) { added.forEach((fn) => fn(info)); },
    unplug(info) { removed.forEach((fn) => fn(info)); },
  };
}

/** The collection a post-beta-8 OnlyKey presents on its vendor interface. */
const VENDOR_COLLECTION = {
  collections: [{ reportIds: [], usage: 1, usagePage: 65451 }],
  deviceId: 42,
  maxFeatureReportSize: 0,
  maxInputReportSize: 64,
  maxOutputReportSize: 64,
  productId: 24828,
  productName: 'ONLYKEY',
  serialNumber: '1000000000',
  vendorId: 7504,
};

module.exports = { FakeOnlyKey, createFakeChromeHid, textReport, MSG, VENDOR_COLLECTION };
