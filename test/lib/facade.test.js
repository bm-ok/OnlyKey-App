/*
 * The OnlyKeyComm.js facade, running as the App runs it - the real
 * dialog-manager.js, OnlyKeyWizard.js and OnlyKeyComm.js loaded into one
 * page-like context (helpers/loadApp.js) - against a scripted key behind a
 * fake chrome.hid (helpers/fakeOnlyKey.js).
 *
 * What these check is the facade's promise to the UI: the same method names
 * and callbacks, and the same last-message strings and flags the UI branches
 * on, with the lib doing the protocol underneath. No NW.js, no selenium, no
 * USB. The firmware-update tests run against the scripted key ONLY.
 */
'use strict';

const { expect } = require('chai');
const crypto = require('crypto');

const { FakeOnlyKey, createFakeChromeHid, VENDOR_COLLECTION } = require('./helpers/fakeOnlyKey');
const { loadApp, until } = require('./helpers/loadApp');

/* ---- helpers ------------------------------------------------------------ */

async function boot(devOpts, { settle = 'status' } = {}) {
  const dev = new FakeOnlyKey(devOpts);
  const fake = createFakeChromeHid(dev);
  const app = loadApp(fake);
  fake.plugIn(VENDOR_COLLECTION);
  const expected = dev.status();
  await until(() => last(app) === expected, { what: `"${expected}" on the message list` });
  if (settle === 'labels') {
    await until(() => Array.isArray(app.run('myOnlyKey.labels')) && app.run('myOnlyKey.labels').length,
      { what: 'labels', timeoutMs: 8000 });
  }
  return { dev, fake, app };
}

const last = (app) => app.run('myOnlyKey.getLastMessage("received")');
const lastSent = (app) => app.run('myOnlyKey.getLastMessage("sent")');

/** Call `expr` (which must pass __done as its callback) and resolve with the callback's args. */
function call(app, expr, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no callback from ${expr}`)), timeoutMs);
    app.sandbox.__done = (...args) => { clearTimeout(timer); resolve(args); };
    app.run(expr);
  });
}

/** The frames the App wrote, as arrays, optionally only one message id. */
function frames(fake, id = null) {
  return fake.sent.map((s) => Array.from(s.bytes)).filter((b) => id === null || b[4] === id);
}

function asBuffer(text) {
  const out = new Array(64).fill(0);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/* ---- tests -------------------------------------------------------------- */

describe('OnlyKeyComm facade: loading and hot-plug', function () {
  this.timeout(20000);

  it('loads with the wizard and starts disconnected', () => {
    const fake = createFakeChromeHid(new FakeOnlyKey());
    const app = loadApp(fake);
    expect(app.run('myOnlyKey.connection')).to.equal(-1);
    expect(app.dom.byId('disconnected-dialog').open).to.equal(true);
    expect(app.errors()).to.deep.equal([]);
  });

  it('a locked classic: OKSETTIME goes out, INITIALIZED comes back, the locked dialog opens', async () => {
    const { app, fake } = await boot({ state: 'locked' });
    const first = fake.sent[0];
    expect(first.reportId).to.equal(0);
    expect(first.bytes.length).to.equal(64);
    expect(Array.from(first.bytes.slice(0, 5))).to.deep.equal([0xff, 0xff, 0xff, 0xff, 0xe4]);
    expect(app.run('myOnlyKey.getDeviceType()')).to.equal('classic');
    expect(app.run('myOnlyKey.isInitialized')).to.equal(true);
    expect(app.run('myOnlyKey.isLocked')).to.equal(true);
    expect(app.dom.byId('locked-dialog').open).to.equal(true);
  });

  it('unlocking on the key: UNLOCKEDv... unlocks the UI and reads the labels', async () => {
    const { app, dev } = await boot({ state: 'locked' });
    dev.state = 'unlocked';
    dev.broadcast();
    await until(() => Array.isArray(app.run('myOnlyKey.labels')) && app.run('myOnlyKey.labels')[0] === 'FooLabel',
      { what: 'labels', timeoutMs: 8000 });
    expect(app.run('myOnlyKey.isLocked')).to.equal(false);
    expect(app.run('myOnlyKey.getVersion()')).to.equal('v3.0.4-prodc');
    expect(app.run('myOnlyKey.labels')).to.have.length(12);
    expect(app.dom.byId('fwVersion').innerText).to.equal('OnlyKey v3.0.4-prodc');
    expect(app.dom.byId('locked-dialog').open).to.equal(false);
  });

  it('an uninitialized key shows the init panel and records UNINITIALIZEDv...', async () => {
    const { app } = await boot({ state: 'uninitialized' });
    expect(last(app)).to.equal('UNINITIALIZEDv3.0.4-prodc');
    expect(app.run('myOnlyKey.isInitialized')).to.equal(false);
    expect(app.run('myOnlyKey.fwUpdateSupport')).to.equal(true);
  });

  it('unplugging disconnects, says "Disconnected" and shows the disconnected dialog', async () => {
    const { app, fake } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    fake.unplug(VENDOR_COLLECTION);
    await until(() => app.run('myOnlyKey.connection') === -1, { what: 'disconnect' });
    expect(last(app)).to.equal('Disconnected');
    expect(fake.openConnection).to.equal(null);
    expect(app.dom.byId('disconnected-dialog').open).to.equal(true);
  });

  it('there is only one reader: the fake chrome.hid never sees two pending receives', async () => {
    /* createFakeChromeHid throws "There must not be multiple pending receives."
     * exactly as the selenium mock does; a whole unlock-and-label session
     * without that error in the log is the check. */
    const { app, dev } = await boot({ state: 'locked' });
    dev.state = 'unlocked';
    dev.broadcast();
    await until(() => Array.isArray(app.run('myOnlyKey.labels')) && app.run('myOnlyKey.labels')[0] === 'FooLabel',
      { what: 'labels', timeoutMs: 8000 });
    const errors = app.errors().map((e) => e.args.map(String).join(' '));
    expect(errors.filter((e) => /pending receive/.test(e))).to.deep.equal([]);
  });
});

describe('OnlyKeyComm facade: slots and settings', function () {
  this.timeout(20000);

  it('setSlot sends the frame the selenium test expects, and calls back on the answer', async () => {
    const { app, fake, dev } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    app.run('myOnlyKey.currentSlotId = "1a"');
    const [err, msg] = await call(app, 'myOnlyKey.setSlot(null, "PASSWORD", "FooPassword", __done)');
    expect(err).to.equal(null);
    expect(msg).to.equal('Successfully set Password');
    expect(frames(fake, 0xe6).pop()).to.deep.equal(asBuffer('\xff\xff\xff\xff\xe6\x01\x05FooPassword'));

    await call(app, 'myOnlyKey.setSlot(null, "NEXTKEY3", "2", __done)');
    expect(frames(fake, 0xe6).pop()).to.deep.equal(asBuffer('\xff\xff\xff\xff\xe6\x01\x062'));
    expect(lastSent(app)).to.equal('OKSETSLOT');
    expect(dev.slotWrites).to.have.length(2);
  });

  it('a slot on a DUO is numbered the DUO way (7a is slot 13)', async () => {
    const { app, fake } = await boot({ model: 'duo', state: 'unlocked', version: 'v3.0.4-prodp' },
      { settle: 'labels' });
    expect(app.run('myOnlyKey.labels')).to.have.length(24);
    app.run('myOnlyKey.currentSlotId = "7a"');
    await call(app, 'myOnlyKey.setSlot(null, "LABEL", "x", __done)');
    expect(frames(fake, 0xe6).pop()[5]).to.equal(13);
  });

  it('wipeSlot calls back on the first "Successfully wiped ..."', async () => {
    const { app } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    app.run('myOnlyKey.currentSlotId = "2b"');
    const [err, msg] = await call(app, 'myOnlyKey.wipeSlot(null, null, __done)');
    expect(err).to.equal(null);
    expect(msg).to.equal('Successfully wiped Label');
  });

  it('a device-wide setting goes to slot 0 through the lib and waits for its answer', async () => {
    const { app, fake } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    app.run('myOnlyKey.setTypeSpeed(5)');
    await until(() => last(app) === 'Successfully set typespeed', { what: 'typespeed answer' });
    expect(frames(fake, 0xe6).pop().slice(0, 8)).to.deep.equal([0xff, 0xff, 0xff, 0xff, 0xe6, 0, 13, 5]);
  });

  it('setLockout: the lib writes it, then the App says "Lockout set to N minutes"', async () => {
    const { app } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    app.dom.byId('lockoutForm').okLockout.value = '15';
    app.run('submitLockout()');
    await until(() => last(app) === 'Lockout set to 15 minutes', { what: 'lockout message' });
  });

  it('a value the lib refuses is shown, and nothing is sent', async () => {
    const { app, fake } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    const before = fake.sent.length;
    app.run('myOnlyKey.setLockButton(9)');
    await until(() => /lockButton must be an integer/.test(last(app)), { what: 'refusal on the list' });
    expect(fake.sent.length).to.equal(before);
  });

  it('second-profile mode (lib gap): the App\'s raw frame, and the callback without an answer', async () => {
    const { app, fake } = await boot({ state: 'uninitialized' });
    const [err] = await call(app, 'myOnlyKey.setSecProfileMode("1", __done)');
    expect(err).to.equal(null);
    expect(frames(fake, 0xe6).pop().slice(0, 8)).to.deep.equal([0xff, 0xff, 0xff, 0xff, 0xe6, 0, 23, 1]);
  });

  it('global Yubico wipe (lib gap): the App\'s raw frame, sent without waiting for a reply that never comes', async () => {
    const { app, fake } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    await call(app, 'myOnlyKey.wipeYubiAuth(__done)');
    expect(frames(fake, 0xe7).pop().slice(0, 7)).to.deep.equal([0xff, 0xff, 0xff, 0xff, 0xe7, 0, 10]);
  });
});

describe('OnlyKeyComm facade: the classic PIN bracket (wizard Steps 2-3)', function () {
  this.timeout(30000);

  it('enterFn/exitFn/enterFn/exitFn set the PIN: armed, stored, confirming, matched', async () => {
    const { app, dev } = await boot({ state: 'uninitialized' });

    /* Step2 enterFn: flushMessage(sendSetPin.bind(cb)) */
    let [err, msg] = await call(app, 'myOnlyKey.flushMessage(myOnlyKey.sendSetPin.bind(myOnlyKey, __done))');
    expect(err).to.equal(null);
    expect(msg).to.equal('OnlyKey is ready, enter your PIN');
    expect(app.run('myOnlyKey.pendingMessages.OKSETPIN')).to.equal(true);

    dev.press('1234567');
    [err, msg] = await call(app, 'myOnlyKey.sendSetPin(__done)'); /* Step2 exitFn */
    expect([err, msg]).to.deep.equal([null, 'Successful PIN entry']);

    [err, msg] = await call(app, 'myOnlyKey.sendSetPin(__done)'); /* Step3 enterFn */
    expect([err, msg]).to.deep.equal([null, 'OnlyKey is ready, re-enter your PIN to confirm']);

    dev.press('1234567');
    [err, msg] = await call(app, 'myOnlyKey.sendSetPin(__done)'); /* Step3 exitFn */
    expect([err, msg]).to.deep.equal([null, 'Successfully set PIN']);

    expect(dev.pins[0xe1]).to.equal('1234567');
    expect(app.run('myOnlyKey.pendingMessages.OKSETPIN')).to.equal(false);
    expect(app.run('myOnlyKey.pinSteps.OKSETPIN')).to.equal(0);
    expect(lastSent(app)).to.equal('OKSETPIN');
  });

  it('a short PIN is refused with (message, "OKSETPIN") - what goBackOnError switches on - and the bracket restarts', async () => {
    const { app, dev } = await boot({ state: 'uninitialized' });
    await call(app, 'myOnlyKey.sendSetPin(__done)');
    dev.press('123');
    const [err, sent] = await call(app, 'myOnlyKey.sendSetPin(__done)');
    expect(err).to.equal('Error PIN is not between 7 - 10 digits');
    expect(sent).to.equal('OKSETPIN');
    expect(app.run('myOnlyKey.pinSteps.OKSETPIN')).to.equal(0);
    expect(dev.pinSet[0xe1]).to.equal(0);
    const [again, msg] = await call(app, 'myOnlyKey.sendSetPin(__done)');
    expect([again, msg]).to.deep.equal([null, 'OnlyKey is ready, enter your PIN']);
  });

  it('a mismatch at the confirm step is refused and returns the key to the start', async () => {
    const { app, dev } = await boot({ state: 'uninitialized' });
    await call(app, 'myOnlyKey.sendSetPin(__done)');
    dev.press('1234567');
    await call(app, 'myOnlyKey.sendSetPin(__done)');
    await call(app, 'myOnlyKey.sendSetPin(__done)');
    dev.press('7654321');
    const [err] = await call(app, 'myOnlyKey.sendSetPin(__done)');
    expect(err).to.equal("Error PINs Don't Match");
    expect(app.run('myOnlyKey.pinSteps.OKSETPIN')).to.equal(0);
    expect(dev.pinSet[0xe1]).to.equal(0);
  });

  it('flushMessage cancels an open entry: the key is back at 0 and the list says "Canceled"', async () => {
    const { app, dev } = await boot({ state: 'uninitialized' });
    await call(app, 'myOnlyKey.sendSetPin(__done)');
    expect(dev.pinSet[0xe1]).to.equal(1);
    await call(app, 'myOnlyKey.flushMessage(__done)');
    expect(last(app)).to.equal('Canceled');
    expect(dev.pinSet[0xe1]).to.equal(0);
    expect(app.run('myOnlyKey.pendingMessages.OKSETPIN')).to.equal(false);
    const texts = app.run('myOnlyKey.lastMessages.received.map((m) => m.text)');
    expect(texts, 'the flush reply is not recorded, as pollForInput({flush}) did not')
      .to.not.include('Error PIN is not between 7 - 10 digits');
  });

  it('the second-profile and self-destruct PINs use their own message and count', async () => {
    const { app, dev } = await boot({ state: 'uninitialized' });
    const [, a] = await call(app, 'myOnlyKey.sendSetPin2(__done)');
    expect(a).to.equal('OnlyKey is ready, enter your PIN');
    const [, b] = await call(app, 'myOnlyKey.sendSetSDPin(__done)');
    expect(b).to.equal('OnlyKey is ready, enter your self-destruct PIN');
    expect(dev.pinSet[0xe3]).to.equal(1);
    expect(dev.pinSet[0xe2]).to.equal(1);
    expect(app.run('myOnlyKey.pinSteps.OKSETPIN2')).to.equal(1);
    expect(app.run('myOnlyKey.pinSteps.OKSETSDPIN')).to.equal(1);
  });

  it('any other "Error ..." ends the step at once instead of waiting out the lib\'s timeout', async () => {
    const { app, dev } = await boot({ state: 'uninitialized' });
    dev.classicPin = function () { this.say('Error not in config mode'); };
    const t = Date.now();
    const [err, sent] = await call(app, 'myOnlyKey.sendSetPin(__done)');
    expect(err).to.equal('Error not in config mode');
    expect(sent).to.equal('OKSETPIN');
    expect(Date.now() - t).to.be.below(3000);
    expect(app.run('myOnlyKey.pinSteps.OKSETPIN || 0')).to.equal(0);
  });
});

describe('OnlyKeyComm facade: DUO PINs', function () {
  this.timeout(20000);

  it('setting DUO PINs sends 0xFF and 16 bytes per PIN, as sendPin_DUO did', async () => {
    const { app, fake, dev } = await boot({ model: 'duo', state: 'uninitialized', version: 'v3.0.4-prodn' });
    await call(app, 'myOnlyKey.sendPin_DUO(["1234567", [], "7654321"], true, __done)');
    const f = frames(fake, 0xe1).pop();
    expect(f[5]).to.equal(0xff);
    expect(f.slice(6, 13)).to.deep.equal(Array.from('1234567', (c) => c.charCodeAt(0)));
    expect(f.slice(6 + 32, 6 + 39)).to.deep.equal(Array.from('7654321', (c) => c.charCodeAt(0)));
    expect(dev.pins.duo).to.equal('1234567');
  });

  it('unlocking a locked DUO: the answer reaches handleMessage and the labels are read', async () => {
    const { app, dev } = await boot({ model: 'duo', state: 'locked', version: 'v3.0.4-prodp' });
    dev.pins.duo = '1234567';
    expect(app.run('myOnlyKey.getDeviceType()')).to.equal('duo');
    await call(app, 'myOnlyKey.sendPin_DUO(["1234567"], false, __done)');
    await until(() => Array.isArray(app.run('myOnlyKey.labels')) && app.run('myOnlyKey.labels').length === 24,
      { what: 'DUO labels after unlock', timeoutMs: 8000 });
    expect(app.run('myOnlyKey.isLocked')).to.equal(false);
  });

  it('a wrong DUO PIN leaves it locked and the dialog logic sees INITIALIZED-D', async () => {
    const { app, dev } = await boot({ model: 'duo', state: 'locked', version: 'v3.0.4-prodp' });
    dev.pins.duo = '1234567';
    await call(app, 'myOnlyKey.sendPin_DUO(["7777777"], false, __done)');
    expect(last(app)).to.equal('INITIALIZED-D');
    expect(app.run('myOnlyKey.isLocked')).to.equal(true);
    expect(app.dom.byId('locked-text-duo').classList.contains('hide')).to.equal(false);
  });
});

describe('OnlyKeyComm facade: keys, backup and restore', function () {
  this.timeout(30000);

  it('an ECC key from the form (hex) goes to its slot and the answer reaches handleMessage', async () => {
    const { app, dev } = await boot({ state: 'unlocked', configMode: true }, { settle: 'labels' });
    const hex = '11'.repeat(32);
    const [err, msg] = await call(app, `myOnlyKey.setPrivateKey(101, 1, "${hex}", __done)`);
    expect([err, msg]).to.deep.equal([null, 'Successfully set ECC Key']);
    expect(dev.keys[101].bytes).to.deep.equal(new Array(32).fill(0x11));
  });

  it('an RSA key goes as 57-byte OKSETPRIV chunks, as submitRsaKey sent it', async () => {
    const { app, fake, dev } = await boot({ state: 'unlocked', configMode: true }, { settle: 'labels' });
    const key = Array.from({ length: 256 }, (_, i) => i & 0xff);
    app.sandbox.__key = key;
    const [err, msg] = await call(app, 'submitRsaKey(1, 2, Array.from(__key), __done)', { timeoutMs: 15000 });
    expect([err, msg]).to.deep.equal([null, 'Successfully set RSA Key']);
    const chunks = frames(fake, 0xef);
    expect(chunks).to.have.length(5); /* 57 * 4 + 28 */
    chunks.forEach((c) => expect(c.slice(5, 7)).to.deep.equal([1, 2]));
    expect(dev.keys[1].bytes).to.deep.equal(key);
  });

  it('a key write outside config mode comes back as the device\'s error', async () => {
    const { app } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    const [err] = await call(app, `myOnlyKey.setPrivateKey(101, 1, "${'22'.repeat(32)}", __done)`);
    expect(err).to.match(/Error not in config mode/);
    expect(last(app)).to.equal('Error not in config mode');
  });

  it('wipePrivateKey wipes the key and leaves the key label alone', async () => {
    const { app, fake } = await boot({ state: 'unlocked', configMode: true }, { settle: 'labels' });
    const before = frames(fake, 0xe6).length;
    const [err, msg] = await call(app, 'myOnlyKey.wipePrivateKey(101, __done)');
    expect([err, msg]).to.deep.equal([null, 'Successfully wiped ECC Private Key']);
    expect(frames(fake, 0xe6).length, 'no label write').to.equal(before);
  });

  it('setBackupPassphrase: SHA-256 of the passphrase into slot 131 as type 161', async () => {
    const { app, fake } = await boot({ state: 'uninitialized' });
    const passphrase = 'correct horse battery staple and more';
    app.sandbox.__pass = passphrase;
    const [err] = await call(app, 'myOnlyKey.setBackupPassphrase(__pass, __done)');
    expect(err).to.equal(null);
    const f = frames(fake, 0xef).pop();
    expect(f.slice(5, 7)).to.deep.equal([131, 161]);
    const sha = Array.from(crypto.createHash('sha256').update(Buffer.from(passphrase, 'latin1')).digest());
    expect(f.slice(7, 39)).to.deep.equal(sha);
    expect(last(app)).to.equal('Successfully set Backup Passphrase');
  });

  it('restore: the lib sends the file as OKRESTORE packets and the App says so', async () => {
    const { app, dev } = await boot({ state: 'uninitialized' });
    const body = Buffer.alloc(80, 7);
    app.sandbox.__file = {
      files: [{ text: `-----BEGIN ONLYKEY BACKUP-----\n${body.toString('base64')}\n-----END ONLYKEY BACKUP-----` }],
    };
    app.run('myOnlyKey.submitRestore(__file, () => {})');
    await until(() => last(app) === 'Backup file sent to OnlyKey, please wait...', { what: 'restore sent' });
    expect(dev.restored).to.have.length(2);
    expect(dev.restored[0][0]).to.equal(0xff);
    expect(dev.restored[1][0]).to.equal(23);
    expect(dev.restored[0].slice(1, 58)).to.deep.equal(new Array(57).fill(7));
  });

  it('restore with no file (the wizard\'s "reboot" - lib gap): the App\'s all-zero OKRESTORE frame', async () => {
    const { app, fake } = await boot({ state: 'uninitialized' });
    app.sandbox.__empty = {};
    app.run('myOnlyKey.submitRestore(__empty, () => {})');
    await until(() => last(app) === 'Backup file sent to OnlyKey.', { what: 'reboot request sent' });
    expect(frames(fake, 0xf1).pop()).to.deep.equal(asBuffer('\xff\xff\xff\xff\xf1'));
  });
});

describe('OnlyKeyComm facade: firmware load - AGAINST THE SCRIPTED KEY ONLY', function () {
  this.timeout(30000);

  it('outside config mode the request is refused and nothing else is sent', async () => {
    const { app, fake } = await boot({ state: 'unlocked' }, { settle: 'labels' });
    app.run('requestFirmwareLoad()');
    await until(() => last(app) === 'Error not in config mode', { what: 'refusal' });
    expect(frames(fake, 0xf4)).to.have.length(1);
  });

  it('in config mode: the "1234" request, then after re-enumeration the blocks, to "Firmware Load Complete!"', async () => {
    const { app, fake, dev } = await boot({ state: 'unlocked', configMode: true }, { settle: 'labels' });
    const block = (n) => `${String(n).repeat(64)}01${'ab'.repeat(32)}${'cd'.repeat(5)}`; /* 140 hex chars */
    app.sandbox.__lines = [block(1), block(2)];
    app.run('onlyKeyConfigWizard.newFirmware = __lines.slice()');

    app.run('requestFirmwareLoad()');
    await until(() => last(app) === 'SUCCESSFULL FW LOAD REQUEST, REBOOTING...', { what: 'request accepted' });
    expect(frames(fake, 0xf4)[0].slice(0, 8)).to.deep.equal([0xff, 0xff, 0xff, 0xff, 0xf4, 2, 0x12, 0x34]);

    /* The key restarts into its bootloader and comes back. */
    dev.state = 'bootloader';
    dev.firmwareBlocks = 2;
    fake.unplug(VENDOR_COLLECTION);
    await until(() => app.run('myOnlyKey.connection') === -1, { what: 'disconnect' });
    fake.plugIn(VENDOR_COLLECTION);
    await until(() => app.dom.byId('firmware-text').innerHTML === 'Firmware Load Complete!',
      { what: 'firmware load', timeoutMs: 15000 });
    expect(app.run('myOnlyKey.isBootloader')).to.equal(true);
    expect(dev.firmwareDone).to.equal(2);
    expect(frames(fake, 0xf4)).to.have.length(1 + 4); /* request + 2 blocks of 2 packets */
    expect(app.run('onlyKeyConfigWizard.newFirmware')).to.equal(null);
  });
});
