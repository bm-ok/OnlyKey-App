const path = require('path');
const webdriver = require('selenium-webdriver');
const By = webdriver.By;
const until = webdriver.until;
const chai = require('chai');
const expect = chai.expect;

const driver = require('./driver.js');

/*
 * TWO THINGS CHANGED UNDER THIS SUITE, AND IT NOW SAYS SO IN CODE.
 *
 * 1. EVERY STEP IS AWAITED. It was written for selenium 3's "control flow",
 *    which queued un-awaited WebDriver calls and ran them in order.
 *    selenium-webdriver 4 (^4.8.0 installs 4.35) removed it: an un-awaited
 *    click(), sendKeys(), click(), getText() now all fire at once, so a check
 *    could read the page before the typing that should have changed it.
 *
 * 2. THE MOCK KEY ANSWERS REQUESTS; IT IS NOT A SCRIPT OF REPLIES. The suite
 *    pushed replies ('UNLOCKED', 'OK', a version, the labels...) before the App
 *    asked, for the old one-shot reader to take in order. The App now talks
 *    through node-onlykey-lib, which keeps ONE continuous reader and runs a
 *    real OKCONNECT handshake: replies ahead of their requests are unsolicited
 *    to it, and the requests time out. So the page's mock connection is bound
 *    to test/lib/helpers/fakeOnlyKey.js - the scripted key `npm run test:lib`
 *    already drives the App's device half with, answering frames in the
 *    firmware's own wording. Frames the App sends go to it; its reports go to
 *    the App's pending receive, in order.
 *
 * The UI steps and what they assert are upstream's.
 */
const FAKE_KEY = path.join(__dirname, 'lib', 'helpers', 'fakeOnlyKey.js');

describe('Configuring a slot on the OnlyKey', function() {

    async function dialogOpen(id) {
        return driver.findElement(By.id(id)).getAttribute('open');
    }

    /* Wait for a condition evaluated in the page (the App answers asynchronously). */
    function waitInPage(script, message, timeoutMs = 10000) {
        return driver.wait(() => driver.executeScript(script), timeoutMs, message);
    }

    function messageToBuffer(msg) {
        let result = new Uint8Array(64);
        for (let i = 0; i < Math.min(msg.length, result.length); ++i) {
            result[i] = msg.charCodeAt(i);
        }
        return result;
    }

    /* The last slot-1 write the key received for `field`, as bytes (header included). */
    function slotWrite(field) {
        return driver.executeScript(function(field) {
            const w = window.__okFake.received
                .filter((f) => f[4] === 0xe6 && f[5] === 1 && f[6] === field)
                .pop();
            return w ? Array.from(w) : null;
        }, field);
    }

    it('should start disconnected', async function() {
        await driver.navigate().refresh();
        // app.html's title is "OnlyKey App" (6.0.0 and the port alike). The
        // old 'OnlyKey Configuration Wizard' wait was never awaited, so it never
        // checked anything.
        await driver.wait(until.titleIs('OnlyKey App'), 15000);
        expect(await dialogOpen('disconnected-dialog')).to.equal('true');
    });

    it('should not show "working..." on startup', async function() {
        expect(await dialogOpen('working-dialog')).to.equal(null);
    });

    it('should show "working..." once a device is connected', async function() {
        // A LOCKED key (the old suite's 'INITIALIZED'), bound to the mock
        // connection before the App learns a device was added. It HOLDS its
        // answers until released, so "working..." is still up when looked at.
        await driver.executeScript(function(fakeKeyPath) {
            const { FakeOnlyKey } = require(fakeKeyPath);
            const key = new FakeOnlyKey({ state: 'locked', version: 'v3.1.0-prodc' });
            const queue = [];
            key.held = true;
            key.pump = () => {
                while (!key.held && queue.length && chromeHid._pendingReceive) {
                    const callback = chromeHid._pendingReceive;
                    chromeHid._pendingReceive = null;
                    // Rebuilt here so the App gets a buffer from ITS context.
                    callback.call(chrome.hid, 0, new Uint8Array(Array.from(queue.shift())).buffer);
                }
            };
            key.out = (report) => { queue.push(report); setTimeout(key.pump, 0); };

            const receive = chromeHid.receive;
            chromeHid.receive = function(connectionId, callback) {
                receive.call(chromeHid, connectionId, callback);
                if (connectionId === 'mockConnection') setTimeout(key.pump, 0);
            };
            const send = chromeHid.send;
            chromeHid.send = function(connectionId, reportId, data, callback) {
                send.call(chromeHid, connectionId, reportId, data, callback);
                if (connectionId === 'mockConnection') {
                    const frame = new Uint8Array(data);
                    setTimeout(() => key.receive(frame), 0);
                }
            };
            window.__okFake = key;
            chromeHid.onDeviceAdded.mockDeviceAdded();
        }, FAKE_KEY);
        expect(await dialogOpen('working-dialog')).to.equal('true');
    });

    it('should ask users to unlock the key', async function() {
        await driver.executeScript(function() {
            window.__okFake.held = false;
            window.__okFake.pump();
        });
        await driver.wait(async () => (await dialogOpen('locked-dialog')) === 'true', 10000,
            'the locked dialog never opened');
    });

    it('should show slot config dialog after clicking button 1a', async function() {
        // The person enters the PIN on the key: it unlocks and says so, the way
        // a real key announces its new state. The App then reads the labels.
        await driver.executeScript(function() {
            window.__okFake.state = 'unlocked';
            window.__okFake.broadcast();
        });
        await waitInPage(function() {
            return window.__okFake.received.some((f) => f[4] === 0xe5);
        }, 'the App never asked the unlocked key for its labels');
        await driver.wait(async () => (await dialogOpen('locked-dialog')) !== 'true', 10000,
            'the locked dialog never closed');
        await driver.findElement(By.id('slot1aConfig')).click();
        await driver.wait(async () => (await dialogOpen('slot-config-dialog')) === 'true', 10000,
            'the slot config dialog never opened');
    });

    it('should show the correct label in the slot config dialog', async function() {
        const label = await driver.findElement(By.id('txtSlotLabel')).getAttribute('value');
        expect(label).to.equal('FooLabel');
    });

    it('should verify the password confirmation field', async function() {
        await driver.findElement(By.id('chkPassword')).click();
        await driver.findElement(By.id('txtPassword')).sendKeys('FooPassword');
        await driver.findElement(By.id('slotSubmit')).click();
        expect(await driver.findElement(By.id('slotConfigErrors')).getText())
            .to.contain('Password fields do not match');
    });

    it('should send the newly set password to the OnlyKey', async function() {
        await driver.findElement(By.id('txtPasswordConfirm')).sendKeys('FooPassword');
        await driver.findElement(By.id('slotSubmit')).click();

        // [255, 255, 255, 255, SETSLOT=230, slotnumber=1, field=5 (PASSWORD), "FooPassword"],
        // read from what the KEY received rather than by position in _sent: the
        // lib's handshake frames come first, and slot writes wait for their acks.
        await waitInPage(function() {
            return window.__okFake.received.some((f) => f[4] === 0xe6 && f[5] === 1 && f[6] === 5);
        }, 'the key never received a password write for slot 1');
        expect(await slotWrite(5)).to.deep.equal(
            Array.from(messageToBuffer('\xff\xff\xff\xff\xe6\x01\x05FooPassword')));
    });

    it('should NOT send <Enter> after the password - the old NEXTKEY3 FIXME does not reproduce', async function() {
        // This step used to expect a NEXTKEY3 = 2 (Return) write after the
        // password, under a FIXME asking whether that was a bug in the form.
        // The form does not send it: the test kit's 04-app/11 established that
        // against the real firmware on 2026-08-05, BEFORE the lib port (the
        // App then was 0c-coder's, unported), and this mock key agrees. So the
        // expectation was stale; the truth is asserted: the password write is
        // the last slot-1 write, and no NEXTKEY3 write follows it.
        await driver.sleep(1000);   // anything the submit still had to send
        const nextKey3 = await slotWrite(6);
        expect(nextKey3, 'a NEXTKEY3 write was sent after the password').to.equal(null);
    });
});
