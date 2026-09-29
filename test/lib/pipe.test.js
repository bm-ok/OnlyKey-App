/*
 * libPipe.js - the chrome.hid pipe and the lib stack over it.
 *
 * Runs in plain Node with mocha (npm run test:lib). No NW.js, no USB: the
 * chrome.hid below is test/lib/helpers/fakeOnlyKey.js.
 */
'use strict';

const { expect } = require('chai');
const path = require('path');

const libPipe = require(path.join(__dirname, '..', '..', 'app', 'scripts', 'onlyKey', 'libPipe.js'));
const { FakeOnlyKey, createFakeChromeHid, textReport } = require('./helpers/fakeOnlyKey');

const VENDOR = libPipe.IFACE.VENDOR;

function frame(bytes) {
  const f = new Uint8Array(64);
  f.set(bytes);
  return f;
}

describe('libPipe: the chrome.hid pipe', function () {
  this.timeout(10000);

  it('connects on start and disconnects on stop', async () => {
    const fake = createFakeChromeHid(null);
    const pipe = libPipe.createChromeHidPipe({ chromeHid: fake.hid, deviceId: 42 });
    expect(pipe.isRunning()).to.equal(false);
    const started = await pipe.start();
    expect(started.connectionId).to.equal('conn-1');
    expect(pipe.isRunning()).to.equal(true);
    expect(fake.pendingReceive, 'the receive loop is armed').to.be.a('function');
    await pipe.stop();
    expect(pipe.isRunning()).to.equal(false);
    expect(fake.openConnection).to.equal(null);
  });

  it('sends report ID 0 and the 64 bytes as they are, and echoes the write as dir IN', async () => {
    const fake = createFakeChromeHid(null);
    const pipe = libPipe.createChromeHidPipe({ chromeHid: fake.hid, deviceId: 42, paceMs: 0 });
    const seen = [];
    pipe.on('stream', (e) => seen.push(e));
    await pipe.start();
    await pipe.write(VENDOR, frame([0xff, 0xff, 0xff, 0xff, 0xe5]));
    expect(fake.sent).to.have.length(1);
    expect(fake.sent[0].reportId).to.equal(0);
    expect(fake.sent[0].bytes.length).to.equal(64);
    expect(Array.from(fake.sent[0].bytes.slice(0, 5))).to.deep.equal([0xff, 0xff, 0xff, 0xff, 0xe5]);
    expect(seen).to.have.length(1);
    expect(seen[0].dir).to.equal(libPipe.DIR.IN);
    expect(seen[0].iface).to.equal(VENDOR);
    await pipe.stop();
  });

  it('refuses any interface but the vendor one, and a frame that is not 64 bytes', async () => {
    const fake = createFakeChromeHid(null);
    const pipe = libPipe.createChromeHidPipe({ chromeHid: fake.hid, deviceId: 42, paceMs: 0 });
    await pipe.start();
    let err = await pipe.write(VENDOR + 1, frame([1])).catch((e) => e);
    expect(err).to.be.an('error');
    err = await pipe.write(VENDOR, new Uint8Array(10)).catch((e) => e);
    expect(err).to.be.an('error');
    expect(fake.sent).to.have.length(0);
    await pipe.stop();
  });

  it('keeps the App\'s 100 ms pacing after a write, except for OKFWUPDATE', async () => {
    const fake = createFakeChromeHid(null);
    const pipe = libPipe.createChromeHidPipe({ chromeHid: fake.hid, deviceId: 42 });
    await pipe.start();
    let t = Date.now();
    await pipe.write(VENDOR, frame([0xff, 0xff, 0xff, 0xff, 0xe6]));
    expect(Date.now() - t).to.be.at.least(95);
    t = Date.now();
    await pipe.write(VENDOR, frame([0xff, 0xff, 0xff, 0xff, 0xf4]));
    expect(Date.now() - t).to.be.below(60);
    await pipe.stop();
  });

  it('re-arms its receive after every report and emits each as dir OUT', async () => {
    const dev = new FakeOnlyKey();
    const fake = createFakeChromeHid(dev);
    const pipe = libPipe.createChromeHidPipe({ chromeHid: fake.hid, deviceId: 42, paceMs: 0 });
    const out = [];
    pipe.on('stream', (e) => { if (e.dir === libPipe.DIR.OUT) out.push(e); });
    await pipe.start();
    dev.say('one');
    dev.say('two');
    dev.say('three');
    await new Promise((r) => setTimeout(r, 50));
    expect(out.map((e) => String.fromCharCode(...e.bytes.slice(0, 5)).replace(/\0/g, '')))
      .to.deep.equal(['one', 'two', 'three']);
    expect(fake.pendingReceive, 'still armed').to.be.a('function');
    await pipe.stop();
  });

  it('stops reading on a receive error instead of spinning on it', async () => {
    const dev = new FakeOnlyKey();
    const fake = createFakeChromeHid(dev);
    let stopped = null;
    const pipe = libPipe.createChromeHidPipe({
      chromeHid: fake.hid,
      deviceId: 42,
      lastError: () => fake.runtime.lastError,
      onReceiveError: (err) => { stopped = err; },
      log: { error() {}, warn() {} },
    });
    await pipe.start();
    fake.setLastError({ message: 'device gone' });
    dev.say('x');
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).to.deep.equal({ message: 'device gone' });
    expect(pipe.isRunning()).to.equal(false);
  });

  it('accepts received data from another V8 context (NW.js page vs module)', () => {
    const vm = require('vm');
    const foreign = vm.runInNewContext('new Uint8Array([85, 78, 76]).buffer');
    expect(foreign instanceof ArrayBuffer).to.equal(false);
    expect(Array.from(libPipe.toBytes(foreign))).to.deep.equal([85, 78, 76]);
  });
});

describe('libPipe: the lib stack over the pipe, against a scripted key', function () {
  this.timeout(15000);

  async function stack(devOpts) {
    const dev = new FakeOnlyKey(devOpts);
    const fake = createFakeChromeHid(dev);
    const pipe = libPipe.createChromeHidPipe({ chromeHid: fake.hid, deviceId: 42, paceMs: 0 });
    const app = await libPipe.composeLibStack({ pipe });
    return { dev, fake, pipe, app, device: app.services.device };
  }

  it('composes host, transport/usb, session, device and okcrypto, with the transport open', async () => {
    const { app, pipe } = await stack();
    for (const service of ['host', 'transport', 'device', 'okcrypto']) {
      expect(app.services[service], service).to.be.an('object');
    }
    /* session is composed but PRIVATE: plugins/session allows only device and
     * okcrypto to consume it, so it is not on app.services. */
    expect(app.services.session).to.equal(undefined);
    expect(pipe.isRunning()).to.equal(true);
    await app.destroy();
    expect(pipe.isRunning()).to.equal(false);
  });

  it('OKCONNECT: the key answers with its status and the lib learns the model', async () => {
    const { app, device, fake } = await stack({ model: 'duo', state: 'unlocked', version: 'v3.0.4-prodp' });
    const result = await device.connect();
    expect(result.status).to.equal('UNLOCKEDv3.0.4-prodp');
    expect(device.deviceType).to.equal('duo');
    expect(fake.sent[0].bytes[4]).to.equal(0xe4);
    await app.destroy();
  });

  it('labels: the key\'s NN|label reports come back as a list', async () => {
    const { app, device, dev } = await stack();
    dev.labels[4] = 'mail';
    const out = await device.readLabels();
    expect(out.labels[0]).to.equal('FooLabel');
    expect(out.labels[4]).to.equal('mail');
    expect(out.labels).to.have.length(12);
    await app.destroy();
  });

  it('setSlot: one frame per field, each waited for', async () => {
    const { app, device, dev } = await stack();
    const applied = await device.setSlot(1, { password: 'FooPassword', nextKey3: '2' });
    expect(applied.map((a) => a.response)).to.deep.equal(
      ['Successfully set Password', 'Successfully set Additional Character3']);
    expect(dev.slotWrites.map((w) => [w.slot, w.field])).to.deep.equal([[1, 5], [1, 6]]);
    await app.destroy();
  });

  it('a device "Error ..." is an error, not an acknowledgement', async () => {
    const { app, device, dev } = await stack();
    dev.state = 'locked';
    const err = await device.readLabels({ timeoutMs: 2000 }).catch((e) => e);
    expect(err.message).to.match(/Error device locked/);
    await app.destroy();
  });

  it('textReport helper matches what the firmware sends', () => {
    expect(Array.from(textReport('OK').slice(0, 3))).to.deep.equal([79, 75, 0]);
  });
});

describe('libPipe: mapping tables', () => {
  it('maps every App slot field the wizard sends to a lib slot field', () => {
    for (const field of ['LABEL', 'URL', 'NEXTKEY4', 'NEXTKEY1', 'DELAY1', 'USERNAME', 'NEXTKEY2',
      'DELAY2', 'PASSWORD', 'NEXTKEY5', 'NEXTKEY3', 'DELAY3', 'TFATYPE', 'TFAUSERNAME',
      'YUBIAUTH', 'TYPESPEED']) {
      expect(libPipe.SLOT_FIELD[field], field).to.be.a('string');
    }
  });

  it('keeps the App\'s \\xNN escapes and refuses non-Latin-1, as sendMessage did', () => {
    expect(libPipe.unescapeAppText('a\\x09b')).to.equal('a\tb');
    expect(() => libPipe.unescapeAppText('€')).to.throw(/not smart enough/);
  });

  it('PIN steps are the firmware\'s four sending steps, in order', () => {
    expect(libPipe.PIN_STEPS).to.deep.equal(['armed', 'stored', 'confirming', 'matched']);
    expect(libPipe.PIN_KIND).to.deep.equal(
      { OKSETPIN: 'primary', OKSETPIN2: 'secondary', OKSETSDPIN: 'selfDestruct' });
  });
});
