const desktopApp = typeof nw !== "undefined";
let userPreferences, request;

if (desktopApp) {
  userPreferences = require("./scripts/userPreferences.js");
  request = require("request");
}

/*
 * THE DEVICE HALF OF THIS FILE IS A FACADE OVER node-onlykey-lib.
 *
 * The OnlyKey object below keeps every method name and callback signature the
 * wizard (OnlyKeyWizard.js) and the form handlers call, and every
 * last-message string the UI branches on. Underneath, the protocol is the
 * lib's: the frames, the PIN bracket, the label reader, the acknowledgement
 * waits, backup, restore and firmware load are its code, the code the other
 * GUIs run. See docs/LIB-PORT.md for the method-by-method mapping.
 *
 * What stays in the App: hot-plug (which collection to open, and when), the
 * UI state machine keyed on message wording, and the DOM.
 *
 * ONE READER. chrome.hid.receive used to be called from wherever a reply was
 * wanted (pollForInput, re-armed by each handler). The lib needs a stream, so
 * libPipe.js runs a self-re-arming receive loop and it is the only reader; the
 * old one-shot reader is gone entirely, not left beside it, because two
 * readers on one connection each take every other report. Every report then
 * reaches onVendorReport() below, which does what pollForInput did to each
 * message (record it, learn the version, track lock state) and hands
 * unsolicited ones to handleMessage, as the idle pollForInput loop did.
 */
let okLibPipe = null;
if (typeof require === "function") {
  try {
    okLibPipe = require("./scripts/onlyKey/libPipe.js");
  } catch (err) {
    console.error("node-onlykey-lib could not be loaded:", err);
  }
}

/* The lib stack while a key is connected: {app, pipe, transport, device, off}. */
let okLib = null;

/*
 * How many lib operations are in flight. While one is, its replies are ITS -
 * the lib is waiting on them - and are not also handed to handleMessage, the
 * same way a reply the old code read into a callback never reached
 * handleMessage. See onVendorReport.
 */
let libBusy = 0;

/* Callers of listen(): each takes the next report, as a receive() did. */
const oneShotListeners = [];

let backupsigFlag = -1;
let fwchecked = false;
let dialog;
let myOnlyKey;
let onlyKeyConfigWizard;

const DEVICE_TYPES = {
  CLASSIC: "classic",
  DUO: "duo",
};

const SUPPORTED_DEVICES = [
  {
    vendorId: 5824, //OnlyKey firmware before Beta 7
    productId: 1158,
    maxInputReportSize: 64,
    maxOutputReportSize: 64,
    maxFeatureReportSize: 0,
  },
  {
    vendorId: 7504, //OnlyKey firmware Beta 7+ http://www.linux-usb.org/usb.ids
    productId: 24828,
    maxInputReportSize: 64,
    maxOutputReportSize: 64,
    maxFeatureReportSize: 0,
  },
  {
    vendorId: 0000, //Black Vault Labs Bootloaderv1
    productId: 45057,
    maxInputReportSize: 64,
    maxOutputReportSize: 64,
    maxFeatureReportSize: 0,
  },
];

function getSupportedDevice(deviceInfo) {
  let supportedDevice;

  for (let d = 0; d < SUPPORTED_DEVICES.length; d++) {
    let device = SUPPORTED_DEVICES[d];

    const isMatch = Object.keys(device).every(
      (prop) => device[prop] == deviceInfo[prop]
    );
    if (isMatch) {
      supportedDevice = device;
      break;
    }
  }
  return supportedDevice;
}

/* jshint esnext:true */

// A proxy for the Chrome HID service. Stored in a global variable so it is
// accessible for integration tests. We use this to simulate an OnlyKey being
// plugged into the computer.
const chromeHid = {
  // chrome.hid.connect(integer deviceId, function callback)
  connect: function (deviceId, callback) {
    if (deviceId === "mockDevice") {
      return callback({
        connectionId: "mockConnection",
      });
    } else {
      return chrome.hid.connect(deviceId, callback);
    }
  },

  // chrome.hid.disconnect(integer connectionId, function callback)
  disconnect: chrome.hid.disconnect,

  // chrome.hid.getDevices(object options, function callback)
  getDevices: chrome.hid.getDevices,

  // chrome.hid.receive(integer connectionId, function callback)
  receive: function (connectionId, callback) {
    if (connectionId === "mockConnection") {
      if (this._pendingReceive) {
        throw "There must not be multiple pending receives.";
      }
      this._pendingReceive = callback;
    } else {
      return chrome.hid.receive(connectionId, callback);
    }
  },

  mockResponse: function (response) {
    // Response is [reportId, data]. Note that WebDriver.executeScript will
    // convert the ArrayBuffer data to an object, so we have to convert it
    // back.
    var [reportId, data] = response;
    response = [reportId, new Uint8Array(Object.values(data)).buffer];

    if (!this._pendingReceive) {
      throw "Expected a pending receive, found none.";
    }
    var callback = this._pendingReceive;
    this._pendingReceive = null;
    callback.apply(chrome.hid, response);
  },

  _pendingReceive: null,

  // chrome.hid.send(integer connectionId, integer reportId, ArrayBuffer data, function callback)
  send: function (connectionId, reportId, data, callback) {
    if (connectionId === "mockConnection") {
      this._sent.push(arguments);

      // Simulate a successful send operation by calling the callback
      // without setting chrome.runtime.lastError.
      callback();
    } else {
      chrome.hid.send(connectionId, reportId, data, callback);
    }
  },

  _sent: [],

  // Event: chrome.hid.onDeviceAdded
  onDeviceAdded: {
    addListener: function (callback) {
      this._callbacks.push(callback);
      return chrome.hid.onDeviceAdded.addListener(callback);
    },

    _callbacks: [],

    mockDeviceAdded: function () {
      this._callbacks.forEach(function (callback) {
        callback.call(null, {
          collections: [
            {
              reportIds: [],
              usage: 1,
              usagePage: 61904,
            },
          ],
          deviceId: "mockDevice",
          maxFeatureReportSize: 0,
          maxInputReportSize: 64,
          maxOutputReportSize: 64,
          productId: 1158,
          productName: "Keyboard/RawHID",
          reportDescriptor: {},
          serialNumber: "4294967295",
          vendorId: 5824,
        });
      });
    },
  },

  // Event: chrome.hid.onDeviceRemoved
  onDeviceRemoved: {
    addListener: function (callback) {
      return chrome.hid.onDeviceRemoved.addListener(callback);
    },
  },
};

function OnlyKeyHID(onlyKeyConfigWizardArg) {
  onlyKeyConfigWizard = onlyKeyConfigWizardArg;
  myOnlyKey = new OnlyKey();
  dialog = new DialogMgr();
}

function OnlyKey(params = {}) {
  this.connection = -1;
  this.currentSlotId = null;

  Object.assign(this, params.deviceInfo); // vendorId, productId, maxInputReportSize, etc

  this.devicePinSet = true;
  this.fwUpdateSupport = false;

  this.isBootloader = false;
  this.isLocked = true;
  this.isConfigMode = false;

  this.keyTypeModifiers = {
    Backup: 128, // 0x80
    Signature: 64, // 0x40
    Decryption: 32, // 0x20
  };

  this.labels = [];

  this.lastMessages = {
    sent: [],
    received: [],
  };

  this.messageHeader = [255, 255, 255, 255];
  this.messageFields = {
    LABEL: 1,
    URL: 15,
    NEXTKEY4: 18, //Before Username
    NEXTKEY1: 16, //After Username
    DELAY1: 17,
    USERNAME: 2,
    NEXTKEY5: 19, //Before OTP
    NEXTKEY2: 3, //After Password
    DELAY2: 4,
    PASSWORD: 5,
    NEXTKEY3: 6, //After OTP
    DELAY3: 7,
    TFATYPE: 8,
    TFAUSERNAME: 9,
    YUBIAUTH: 10,
    YUBIANDHMAC: 29,
    LOCKOUT: 11,
    WIPEMODE: 12,
    BACKUPKEYMODE: 20,
    derivedchallengeMode: 21,
    storedchallengeMode: 22,
    webAgentDeriveMode: 30,
    webcryptPolicy: 31,
    SECPROFILEMODE: 23,
    TYPESPEED: 13,
    LEDBRIGHTNESS: 24,
    LOCKBUTTON: 25,
    hmacchallengeMode: 26,
    modkeyMode: 27,
    KBDLAYOUT: 14,
  };

  this.messages = {
    OKSETPIN: 225, //0xE1
    OKSETSDPIN: 226, //0xE2
    OKSETPIN2: 227, //0xE3
    OKSETTIME: 228, //0xE4
    OKGETLABELS: 229, //0xE5
    OKSETSLOT: 230, //0xE6
    OKWIPESLOT: 231, //0xE7
    OKGETPUBKEY: 236,
    OKSIGN: 237,
    OKWIPEPRIV: 238,
    OKSETPRIV: 239,
    OKDECRYPT: 240,
    OKRESTORE: 241,
    OKFWUPDATE: 244,
  };

  this.pendingMessages = {};

  /*
   * How far the classic PIN bracket has got, per PIN message id: the number
   * of messages of that kind the firmware has taken since its `pin_set` was
   * last 0 (okcore.cpp set_primary_pin and siblings). pendingMessages above is
   * this count's parity, which is all the old code tracked; the count itself
   * says WHICH step comes next, and that is what the lib's pinStep() needs.
   */
  this.pinSteps = {};
  this.version = "";
}

OnlyKey.prototype.setConnection = function (connectionId) {
  console.info("Setting connectionId to " + connectionId);
  this.connection = connectionId;

  if (connectionId === -1) {
    myOnlyKey = new OnlyKey({
      deviceInfo: this.deviceInfo,
    });
    myOnlyKey.setInitialized(false);
    dialog.open(ui.disconnectedDialog);
  } else {
    dialog.open(ui.workingDialog);
    onlyKeyConfigWizard.init(myOnlyKey);
  }
};

/*
 * NO RAW FRAMES. sendMessage, which built a 64-byte frame by hand, is gone:
 * every operation the App performs is now a lib method, including the three
 * the port's first cut still sent by hand because the lib had no method for
 * them (docs/LIB-PORT.md, "lib gaps"): the global Yubico wipe, second-profile
 * mode and the no-file restart. The last caller was setSlot's fallback for a
 * field the lib has no name for, and no field the App writes reaches it (see
 * setSlot), so it now refuses instead of hand-building a frame.
 */

/**
 * Run one lib operation, marked as in flight for onVendorReport.
 *
 * `sentLabel` is recorded as the last message SENT, as sendMessage recorded
 * its msgId - handleMessage and goBackOnError branch on it.
 */
function libOp(sentLabel, run) {
  if (!okLib) return Promise.reject(new Error("OnlyKey is not connected"));
  if (sentLabel) myOnlyKey.setLastMessage("sent", sentLabel);
  const lib = okLib;
  libBusy++;
  return Promise.resolve()
    .then(() => run(lib.device, lib))
    .finally(() => {
      libBusy--;
    });
}

/** An error's text, whatever shape it arrived in. */
function errorText(err) {
  return String((err && err.message) || err || "");
}

/**
 * Show a lib refusal the device never said.
 *
 * A reply from the device is already on the last-message list (onVendorReport
 * records every one). A refusal the LIB makes - a value out of range, a
 * missing acknowledgement - never crossed the wire, so without this the user
 * would see nothing at all.
 */
function reportLibError(err) {
  const text = errorText(err);
  console.error("OnlyKey:", text);
  const last = myOnlyKey.getLastMessage("received");
  const saidByDevice = (err && err.deviceText) || (last && text.includes(last));
  if (text && !saidByDevice) {
    myOnlyKey.setLastMessage("received", text);
  }
  return (err && err.deviceText) || text;
}

OnlyKey.prototype.setLastMessage = function (type, msgStr = "") {
  if (msgStr) {
    var newMessage = {
      text: msgStr,
      timestamp: new Date().getTime(),
    };
    var messages = this.lastMessages[type] || [];
    var numberToKeep = 3;
    if (messages.length === numberToKeep) {
      messages.slice(numberToKeep - 1);
    }
    messages = [newMessage].concat(messages);
    this.lastMessages[type] = messages;
    if (type === "received" && onlyKeyConfigWizard) {
      onlyKeyConfigWizard.setLastMessages(messages);
    }
  }
};

OnlyKey.prototype.getLastMessage = function (type) {
  return this.lastMessages[type] &&
    this.lastMessages[type][0] &&
    this.lastMessages[type][0].hasOwnProperty("text")
    ? this.lastMessages[type][0].text
    : "";
};

OnlyKey.prototype.getLastMessageIndex = function (type, index) {
  return this.lastMessages[type] &&
    this.lastMessages[type][index] &&
    this.lastMessages[type][index].hasOwnProperty("text")
    ? this.lastMessages[type][index].text
    : "";
};

/*
 * CANCEL A HALF-FINISHED CLASSIC PIN ENTRY.
 *
 * The firmware's PIN bracket is a toggle: each OKSETPIN (or OKSETPIN2 /
 * OKSETSDPIN) advances `pin_set` 0 -> 1 -> 2 -> 3 -> 0, and entry is OPEN on
 * the odd counts. A wizard step that is left while entry is open (Cancel,
 * Exit, "skip", a panel switch) leaves the device capturing button presses,
 * so every step's enterFn flushes first. Flushing is sending the next message
 * of that kind: with no digits pressed the firmware refuses it ("PIN is not
 * between 7 - 10 digits", or a mismatch) and goes back to 0 - okcore.cpp
 * set_primary_pin cases 1 and 3.
 *
 * Same contract as before: one pending kind at a time, "Canceled" as the last
 * received message, then the callback. The flush reply itself is NOT recorded
 * on the message list (the old pollForInput({flush: true})), which is what
 * `this.flushing` tells onVendorReport.
 */
OnlyKey.prototype.flushMessage = async function (callback = () => {}) {
  const messageTypes = Object.keys(this.pendingMessages);
  const pendingMessagesTypes = messageTypes.filter(
    (type) => this.pendingMessages[type] === true
  );

  if (!pendingMessagesTypes.length) {
    console.info("No pending messages to flush.");
    return callback();
  }

  const msgId = pendingMessagesTypes[0];

  console.info(`Flushing pending ${msgId}.`);
  this.flushing = true;
  this.sendPinMessage({ msgId, poll: false }, (err, msg) => {
    this.flushing = false;
    this.setLastMessage("received", "Canceled");
    if (this.pendingMessages[msgId] === true) {
      /*
       * Still odd: the device did not answer at all, so its state is unknown.
       * Given up on rather than retried - the old code waited forever here,
       * and retrying a silent device would loop. The next step's own message
       * will say where the device is.
       */
      console.warn(`Flush of ${msgId} got no answer (${err}); giving up on it.`);
      this.pendingMessages[msgId] = false;
      return callback();
    }
    console.info("Flushed previous message.");
    return this.flushMessage(callback);
  });
};

/* Kept for API compatibility; nothing in the App calls it now. Resolves on the
 * next message, as listenForMessageIncludes2 did on the desktop. */
OnlyKey.prototype.listenforvalue = function (succeed_msg) {
  return new Promise((resolve, reject) => {
    this.listen((err, msg) => (err ? reject(err) : resolve(msg)));
  });
};

/*
 * The next report, once. Kept for API compatibility: it used to arm a
 * chrome.hid.receive, and now takes the next report from the one reader
 * instead (onVendorReport), so it can never become a second reader.
 */
OnlyKey.prototype.listen = function (callback) {
  oneShotListeners.push(typeof callback === "function" ? callback : handleMessage);
};

/*
 * SET TIME = the lib's device.connect().
 *
 * OKSETTIME and OKCONNECT are the same message (0xE4) and carry the time at
 * the same offset; the lib's also carries a transit public key, which the
 * vendor path ignores (plugins/session connect). The device answers with its
 * status - UNINITIALIZEDv..., INITIALIZED[-D], UNLOCKEDv..., BOOTLOADER.
 *
 * The callback gets (null, status) - the reply the old code read after
 * sending. It used to be sent TWICE ("fixes issue where when attaching
 * OnlyKey to a VM response is not received"); the lib waits for an answer, so
 * the second send is now a retry that only happens when the first goes
 * unanswered, which is the case it existed for.
 *
 * Fire-and-forget like the old one (it returned before the reply), and
 * coalesced: a setTime asked for while one is in flight gets that one's
 * answer. The config-mode path in onVendorReport asks for one per status
 * report, and without this each answer would start another connect.
 */
let setTimeWaiters = null;

OnlyKey.prototype.setTime = async function (callback) {
  const cb = typeof callback === "function" ? callback : handleMessage;
  if (setTimeWaiters) {
    setTimeWaiters.push(cb);
    return;
  }
  setTimeWaiters = [cb];
  console.info("Setting current epoch time =", Math.round(Date.now() / 1000.0).toString(16));

  libOp("OKSETTIME", async (device) => {
    try {
      return await device.connect();
    } catch (first) {
      console.warn("OKSETTIME got no answer, sending it again:", errorText(first));
      return device.connect();
    }
  }).then(
    (result) => {
      const waiters = setTimeWaiters || [];
      setTimeWaiters = null;
      waiters.forEach((fn) => fn(null, (result && result.status) || ""));
    },
    (err) => {
      const waiters = setTimeWaiters || [];
      setTimeWaiters = null;
      console.error("ERROR SENDING OKSETTIME:", errorText(err));
      waiters.forEach((fn) => fn("ERROR SENDING PACKETS"));
    }
  );
};

/*
 * LABELS = the lib's device.readLabels().
 *
 * It sends OKGETLABELS and collects the device's `NN|label` reports itself,
 * skipping status broadcasts, and ends on the last slot of the model - which
 * is why the model is handed over first: 12 on a classic, 24 on a DUO. The
 * old handleGetLabels did the same collecting by re-listening once per label.
 *
 * The 900 ms wait is kept: getLabels is called straight after setTime, and
 * the old code waited for that exchange to finish before asking.
 */
OnlyKey.prototype.getLabels = async function () {
  this.labels = "";
  await wait(900);
  const appType = this.getDeviceType();
  const libType =
    appType === DEVICE_TYPES.DUO ? "duo" : appType === DEVICE_TYPES.CLASSIC ? "classic" : null;

  try {
    const out = await libOp("OKGETLABELS", (device) => {
      device.setDeviceType(libType);
      return device.readLabels();
    });
    this.labels = out.labels;
    initSlotConfigForm();
  } catch (err) {
    const text = errorText(err);
    this.labels = (err && err.partial && err.partial.labels) || [];
    if (text.includes("Error not in config mode")) {
      this.setLastMessage("received", "Error not in config mode");
    } else {
      console.warn("Reading labels failed:", text);
    }
    if (this.labels.some((label) => label !== null && label !== undefined)) {
      initSlotConfigForm();
    }
  }
};

/*
 * ONE STEP OF THE CLASSIC PIN BRACKET = the lib's device.pinStep().
 *
 * THE MAPPING (risk 2 in the port plan). The wizard drives the bracket from
 * its steps - it has always been the thing deciding when each message goes,
 * because the person presses the key's buttons in between:
 *
 *   wizard                              count  lib pinStep   device answers
 *   Step2 enterFn  flush, sendSetPin    0->1   'armed'       "OnlyKey is ready, enter your PIN"
 *     (person presses the PIN on the key)
 *   Step2 exitFn   sendSetPin           1->2   'stored'      "Successful PIN entry"
 *   Step3 enterFn  sendSetPin           2->3   'confirming'  "...ready, re-enter your PIN to confirm"
 *     (person presses it again)
 *   Step3 exitFn   sendSetPin           3->0   'matched'     "Successfully set PIN"
 *
 * and the same for OKSETPIN2 (Steps 4/5, kind 'secondary') and OKSETSDPIN
 * (Steps 6/7, kind 'selfDestruct'). The count is the firmware's own
 * `pin_set`.
 *
 * 'committed' RUNS RIGHT AFTER 'matched', in the same call, because that is
 * the lib's sequence and it now costs nothing: the wire says nothing after
 * "Successfully set PIN", and the lib waits for the console's copy only when
 * a console has spoken - which a release build's never does (its line is
 * DEBUG-only) and this App's pipe, which opens only the vendor interface,
 * never carries. The port's first cut skipped the step because the lib used
 * to wait out the full timeout for it.
 *
 * A REFUSAL - "Error PIN is not between 7 - 10 digits" at 'stored', or at
 * 'matched' a mismatch - sends the firmware back to 0, so the count goes to 0
 * too, and the callback gets (message, msgId) exactly as pollForInput gave it,
 * which is what the wizard's goBackOnError switches on to return to Step2 / 4
 * / 6. Any other refusal (not in config mode, locked) ends the step at once
 * too: the lib's pinStep ends on ANY device refusal, not just the two PIN
 * sentences (the App raced its own "Error" watcher for this until the lib
 * did it). The count is left alone then, because the firmware never took the
 * message.
 *
 * The DUO has no bracket: its PINs travel in the message (sendPin_DUO).
 */
OnlyKey.prototype.sendPinMessage = function ({ msgId = "", pin = "", poll = true }, callback = () => {}) {
  console.info(`sendPinMessage ${msgId}`);

  if (this.getDeviceType() === DEVICE_TYPES.DUO) {
    /*
     * Not sent. On a DUO this only ever carried the PIN bytes for sendPin_DUO,
     * which now goes to the lib's duoPin() directly. The one other way here was
     * flushMessage, which on a DUO sent an EMPTY PIN message (the toggle below
     * was shared with the classic bracket), and a DUO has nothing to flush.
     */
    this.pendingMessages[msgId] = false;
    return callback(null, this.getLastMessage("received"));
  }

  const kind = okLibPipe && okLibPipe.PIN_KIND[msgId];
  if (!kind) return callback(`unknown PIN message ${msgId}`, msgId);

  const at = this.pinSteps[msgId] || 0;
  const label = okLibPipe.PIN_STEPS[at];

  libOp(msgId, async (device) => {
    await device.pinStep(label, { kind });
    if (label === "matched") await device.pinStep("committed", { kind });
  }).then(
    () => {
      this.pinSteps[msgId] = (at + 1) % okLibPipe.PIN_STEPS.length;
      this.pendingMessages[msgId] = this.pinSteps[msgId] % 2 === 1;
      callback(null, this.getLastMessage("received"));
    },
    (err) => {
      const text = errorText(err);
      if (/PIN is not between|PINs Don'?t Match/i.test(text)) {
        this.pinSteps[msgId] = 0;
        this.pendingMessages[msgId] = false;
      } else if (!/^Error/i.test(text)) {
        reportLibError(err);
      }
      callback(text, msgId);
    }
  );
};

OnlyKey.prototype.sendSetPin = function (callback) {
  this.sendPinMessage({ msgId: "OKSETPIN" }, callback);
};

OnlyKey.prototype.sendSetSDPin = function (callback) {
  this.sendPinMessage({ msgId: "OKSETSDPIN" }, callback);
};

OnlyKey.prototype.sendSetPin2 = function (callback) {
  this.sendPinMessage({ msgId: "OKSETPIN2" }, callback);
};

/*
 * DUO PINs = the lib's device.duoPin().
 *
 * One message either way: `setpin` true carries every PIN, 16 bytes each,
 * behind a 0xFF (setting them); false carries one PIN (an unlock attempt).
 * The lib builds the same bytes the old loop did (src/device/pin.js
 * encodeDuoPins) and returns the device's first answer.
 *
 * The dialog logic below is unchanged and still reads the LAST RECEIVED
 * message; it now runs after the answer instead of 100 ms after the send, so
 * it judges the attempt that was just made. On a locked key the answer is also
 * handed to handleMessage, where the old always-armed handleMessage loop took
 * it: that is how UNLOCKED... reaches the unlock path.
 */
OnlyKey.prototype.sendPin_DUO = function (pins, setpin, callback) {
  const unlocking = this.isLocked == true && this.isInitialized == true;
  libOp("OKSETPIN", (device) => device.duoPin(pins, { set: setpin == true })).then(
    (reply) => {
      const msgReceived = myOnlyKey.getLastMessage("received");
      console.info(`sendPin_DUO last message received: ${msgReceived}`);

      // Check if PIN attempts exceeded
      if (msgReceived.indexOf("Error password attempts for this session exceeded") === 0) {
        // max pin attempts dialog
        document.getElementById("locked-text-duo").classList.add("hide");
        document.getElementById("max-pin-attempts-duo").classList.remove("hide");
        document.getElementById("incorrect-pin-duo").classList.add("hide");
        console.info("PIN attempts exeeded");
      } else if (msgReceived.indexOf("INITIALIZED-D") === 0) {
        // incorrect pin dialog
        document.getElementById("locked-text-duo").classList.remove("hide");
        document.getElementById("max-pin-attempts-duo").classList.add("hide");
        setTimeout(function() {
          document.getElementById("incorrect-pin-duo").classList.remove("hide");
        }, 2000);
        console.info("Incorrect PIN attempt");
      } else {
        // normal PIN dialog
        document.getElementById("locked-text-duo").classList.remove("hide");
        document.getElementById("max-pin-attempts-duo").classList.add("hide");
        document.getElementById("incorrect-pin-duo").classList.add("hide");
      }
      if (unlocking) {
        const text = readBytes(new Uint8Array(Array.from(reply || [])));
        if (text) routeToHandleMessage(text);
      }
      return callback();
    },
    (err) => callback(reportLibError(err))
  );
};

/*
 * ONE SLOT FIELD = the lib's device.setSlot(slot, {field: value}).
 *
 * The wizard writes a slot one field at a time and moves to the next field
 * from this callback (OnlyKeyWizard.js setSlot), so the signature is kept.
 * The difference is WHEN the callback runs: it used to run 100 ms after the
 * send, with the device's answer left unread; now it runs on the answer, so
 * "Error ..." reaches the wizard as an error instead of being skipped over.
 * The lib retries a write the device did not answer at all, which the
 * firmware tolerates because each field write is a complete store.
 *
 * Slot "XX" (0) carries the device-wide settings; those go to setPreference.
 */
OnlyKey.prototype.setSlot = function (slotArg, field, value, callback) {
  let slot = slotArg || this.getSlotNum();
  if (typeof slot !== "number") slot = this.getSlotNum(slot);
  const done = typeof callback === "function" ? callback : () => {};

  if (slot === 0 && okLibPipe && okLibPipe.PREFERENCE[field]) {
    return setPreferenceField(field, value, done);
  }

  /*
   * A field the lib has no name for is REFUSED, not hand-built. Every field
   * the wizard writes (OnlyKeyWizard.js setSlot's fieldMap) and setSlotTypeSpeed
   * is in SLOT_FIELD, so this is reached only by a caller outside the App; the
   * lib's setSlot is where a new field belongs, with its encoding and its
   * acknowledgement, not a raw frame here that nobody would be waiting on.
   */
  const name = okLibPipe && okLibPipe.SLOT_FIELD[field];
  if (!name) {
    return done(reportLibError(new Error(`setSlot: the library has no slot field ${field}`)));
  }

  let fieldValue;
  try {
    fieldValue = okLibPipe.slotValue(field, value);
  } catch (err) {
    return done(reportLibError(err));
  }

  return libOp("OKSETSLOT", (device) => device.setSlot(slot, { [name]: fieldValue })).then(
    (applied) => done(null, applied.length ? applied[applied.length - 1].response : "OK"),
    (err) => done(reportLibError(err))
  );
};

/*
 * WIPE A SLOT = the lib's device.wipeSlot(). The callback runs on the device's
 * first "Successfully wiped ..." (the firmware sends one per field; the rest
 * arrive afterwards and are recorded like any other message).
 */
OnlyKey.prototype.wipeSlot = function (slotArg, field, callback) {
  let slot = slotArg || this.getSlotNum();
  if (typeof slot !== "number") slot = this.getSlotNum(slot);
  const done = typeof callback === "function" ? callback : () => {};
  const name = field ? okLibPipe && okLibPipe.SLOT_FIELD[field] : null;
  if (field && !name) return done(`wipeSlot: unknown field ${field}`);

  /* The lib (0.3.0) resolves {slot, response, responses} - every reply the
   * firmware sends; `response` is the first, the string this callback has
   * always been given. */
  return libOp("OKWIPESLOT", (device) => device.wipeSlot(slot, name)).then(
    (r) => done(null, r.response),
    (err) => done(reportLibError(err))
  );
};

OnlyKey.prototype.getSlotNum = function (slotIdArg) {
  const slotId = slotIdArg || this.currentSlotId;
  let slotNum;
  if (slotId=='XX') {
    slotNum = 0;
  } else if (this.getDeviceType() === DEVICE_TYPES.DUO) {
    if (parseInt(slotId, 10) <= 3) {
    slotNum = parseInt(slotId, 10) + (slotId.match(/a|b/)[0] === 'a' ? 0 : 3);
    } else if (parseInt(slotId, 10) <= 6) {
      slotNum = parseInt(slotId, 10) + (slotId.match(/a|b/)[0] === 'a' ? 3 : 6);
    } else if (parseInt(slotId, 10) <= 9) {
      slotNum = parseInt(slotId, 10) + (slotId.match(/a|b/)[0] === 'a' ? 6 : 9);
    } else if (parseInt(slotId, 10) <= 12) {
      slotNum = parseInt(slotId, 10) + (slotId.match(/a|b/)[0] === 'a' ? 9 : 12);
    }
  } else {
    slotNum = parseInt(slotId, 10) + (slotId.match(/a|b/)[0] === 'a' ? 0 : 6);
  }
  return slotNum;
};

/*
 * THE DEVICE-GLOBAL YUBICO CREDENTIAL = the lib's device.setYubiAuth().
 * publicId arrives as hex - submitYubiAuthForm converts the typed modhex -
 * which is what the lib wants for the global slot. The lib validates first
 * (exactly 6/6/16 bytes) and sends nothing if a field is wrong; that reason is
 * shown as the last message. The callback still runs either way, as it did.
 */
OnlyKey.prototype.setYubiAuth = function (
  publicId,
  privateId,
  secretKey,
  callback
) {
  const done = typeof callback === "function" ? callback : () => {};
  libOp("OKSETSLOT", (device) => device.setYubiAuth({ publicId, privateId, secretKey })).then(
    () => done(),
    (err) => done(reportLibError(err))
  );
};

/*
 * THE GLOBAL YUBICO WIPE = the lib's device.wipeYubiAuth().
 *
 * The firmware wipes the global credential SILENTLY (okcore.cpp wipe_slot,
 * `value == 10 && slot == 0` has no hidprint), so there is no "wiped" answer to
 * wait for - the old code waited for "wiped AES Key", which no release sends.
 * The lib sends the frame ONCE, listens briefly for a refusal ("Error device
 * locked", ...), and otherwise returns `confirmed: false`: silence is what
 * success looks like, but it is also what a frame the key never acted on looks
 * like. So the list says the wipe was SENT, never that it was done, and a
 * refusal is shown as the device said it and passed to the callback.
 */
const SILENT_NOTE = "OnlyKey does not confirm this";

OnlyKey.prototype.wipeYubiAuth = function (callback) {
  const done = typeof callback === "function" ? callback : () => {};
  libOp("OKWIPESLOT", (device) => device.wipeYubiAuth()).then(
    () => {
      this.setLastMessage("received", `Yubico OTP wipe sent (${SILENT_NOTE})`);
      done(null);
    },
    (err) => done(reportLibError(err))
  );
};

OnlyKey.prototype.setRSABackupKey = async function (key, passcode, cb) {
  var privKey;
  let error;

  try {
    var privKeys = await openpgp.key.readArmored(key);
    privKey = privKeys.keys[0];

    var success = privKey.decrypt(passcode);

    if (!success) {
      error = "Private Key decryption failed.";
      this.setLastMessage("received", error + " Did you forget your passcode?");
      throw Error(error);
    }

    if (!(privKey.primaryKey && privKey.primaryKey.params)) {
      error =
        "Private Key decryption was successful, but resulted in invalid mpi data.";
      this.setLastMessage("received", error);
      throw Error(error);
    }

    if (
      !(
        privKey.primaryKey &&
        privKey.primaryKey.params &&
        privKey.primaryKey.params.length === 6
      )
    ) {
      error =
        "Private Key decryption was successful, but resulted in invalid mpi data.";
      this.setLastMessage("received", error);
      throw Error(error);
    }
  } catch (parseError) {
    error = "Error parsing RSA key.";
    this.setLastMessage("received", error);
    throw Error(error + "\n\n" + parseError);
  }

  await onlyKeyConfigWizard.initKeySelect(privKey, function (err) {
    ui.rsaForm.setError(err || "");
    if (typeof cb === "function") cb(err);
  });
};

/*
 * BACKUP PASSPHRASE = the lib's device.setBackupPassphrase().
 *
 * The lib derives the key the way this did - SHA-256 of the passphrase into
 * slot 131 as type 161 (src/device/keys.js backupKeyFromPassphrase) - and
 * waits for the device's answer, resending once if there is none.
 *
 * The callback keeps the old contract: it ran once the device said ANYTHING
 * ("Success..." or "Error not in config mode" alike, listenForMessageIncludes2)
 * with no error, so the wizard moved on either way and the message list said
 * which. A device refusal therefore still calls back clean; only no answer at
 * all, or a passphrase the lib refuses before sending, is an error now.
 */
OnlyKey.prototype.setBackupPassphrase = async function (passphrase, cb) {
  const done = typeof cb === "function" ? cb : () => {};
  libOp("OKSETPRIV", (device) => device.setBackupPassphrase(passphrase)).then(
    () => {
      onlyKeyConfigWizard.initForm.reset();
      done(null);
    },
    (err) => {
      onlyKeyConfigWizard.initForm.reset();
      const text = errorText(err);
      if (/: Error/i.test(text)) return done(null);
      done(reportLibError(err));
    }
  );
};

OnlyKey.prototype.submitFirmware = function (fileSelector, cb) {
  if (fileSelector.files && fileSelector.files.length) {
    var file = fileSelector.files[0];
    var reader = new FileReader();

    reader.onload = (function (theFile) {
      return async function (e) {
        let contents = e.target && e.target.result && e.target.result.trim();

        try {
          console.info("unparsed contents", contents);
          contents = parseFirmwareData(contents);
          console.info("parsed contents", contents);
        } catch (parseError) {
          throw new Error("Could not parse firmware file.\n\n" + parseError);
        }

        if (contents) {
          onlyKeyConfigWizard.newFirmware = contents;
          if (!myOnlyKey.isBootloader) {
            console.info("Working... Do not remove OnlyKey");
            //First send one message to kick OnlyKey (in config mode) into bootloader
            requestFirmwareLoad(() => console.info("Firmware file sent to OnlyKey"));
          } else {
            await loadFirmware();
          }
        } else {
          throw new Error("Incorrect firmware data format.");
        }
      };
    })(file);

    // Read in the image file as a data URL.
    reader.readAsText(file);
  } else {
    throw new Error("Please select a file first.");
  }
};

/*
 * RESTORE = the lib's device.restore(), which checks the file's rolling
 * SHA-256 before a byte goes out and then sends it in the same OKRESTORE
 * packets this used to. Two differences, both deliberate:
 *
 *   - a file whose digest is present and WRONG is refused (the lib always
 *     refuses it); the App used to send it anyway
 *   - a file with NO digest line (firmware before v2.1.2) is sent, as the App
 *     always did - `unverifiable: true` is that decision, made here once
 *
 * The no-file path is NOT a restore: the wizard sends it to make the key
 * restart - Exit on the restore step ("Reboot Requested", OnlyKeyWizard.js),
 * and Next on it with no file chosen. That is the lib's
 * device.restartByRestore(): one OKRESTORE frame whose length byte and data
 * are zero, which the firmware's RESTORE takes as an empty last packet at
 * offset 0 and answers with CPU_RESTART.
 *
 * THE ZERO IS NOW MEANT. The old App got the same 64 bytes by accident: it
 * sent "000000000" (nine characters) through submitRestoreData, whose length
 * header came out as (9/2).toString(16) = "4.8", which hexStrToDec turned
 * into NaN and the Uint8Array stored as 0. A header of 4 would have been a
 * 4-byte "backup" that the key went on to decrypt. The lib builds the frame
 * with an explicit zero, and submitRestoreData and OnlyKey.prototype.restore,
 * which existed only for this path, are gone.
 *
 * A restart answers nothing - the key drops off the bus - so the lib returns
 * `confirmed: false` after listening briefly for a refusal. The firmware
 * restarts only where a restore is allowed (config mode, or first use); on an
 * unlocked key outside config mode it says "Error not in config mode", which
 * reaches the list and the callback. The list says the restart was REQUESTED,
 * because that is all the App can know.
 */
OnlyKey.prototype.submitRestore = function (fileSelector, cbArg) {
  const cb = typeof cbArg === "function" ? cbArg : () => {};
  const _this = this;
  ui.restoreForm.setError("");

  if (fileSelector.files && fileSelector.files.length) {
    var file = fileSelector.files[0];
    var reader = new FileReader();

    reader.onload = (function (theFile) {
      return function (e) {
        const text = e.target && e.target.result && e.target.result.trim();
        var contents;
        try {
          contents = parseBackupData(text);
        } catch (parseError) {
          const error = "Could not parse backup file.";
          _this.setLastMessage("received", error);
          throw Error(error + "\n\n" + parseError);
        }

        if (contents) {
          var step10text = document.getElementById("step10-text");
          step10text.innerHTML =
            "Restoring from backup please wait...<br><br>" +
            "<img src='/images/Pacman-0.8s-200px.gif' height='40' width='40'><br><br>";
          libOp("OKRESTORE", (device) => device.restore(text, { unverifiable: true })).then(
            async () => {
              _this.setLastMessage("received", "Backup file sent to OnlyKey, please wait...");
              await wait(10000);
              step10text.innerHTML = "";
              cb();
            },
            (err) => {
              step10text.innerHTML = "";
              reportLibError(err);
            }
          );
        } else {
          const error = "Incorrect backup data format.";
          _this.setLastMessage("received", error);
          throw Error(error);
        }
      };
    })(file);

    // Read in the image file as a data URL.
    reader.readAsText(file);
  } else {
    libOp("OKRESTORE", (device) => device.restartByRestore()).then(
      () => {
        _this.setLastMessage("received", `OnlyKey restart requested (${SILENT_NOTE})`);
        cb();
      },
      /*
       * A refusal stops the wizard where it is (goBackOnError has no case for
       * OKRESTORE), which is where the old code left it when a send failed.
       */
      (err) => cb(reportLibError(err), "OKRESTORE")
    );
  }
};

/*
 * A PRIVATE KEY = the lib's device.loadKey(slot, {type, key}).
 *
 * `type` is the App's byte - algorithm plus the backup/signature/decryption
 * modifier bits - passed through unchanged. The lib sends a key that fits one
 * report as one frame, and a longer (RSA) key as the same 57-byte OKSETPRIV
 * chunks submitRsaKey used to, then waits for "Successfully set ... Key".
 * The callback gets that answer as its message.
 */
OnlyKey.prototype.setPrivateKey = async function (slot, type, key, callback) {
  const done = typeof callback === "function" ? callback : () => {};
  const bytes =
    Array.isArray(key) || (key && typeof key !== "string" && typeof key.length === "number")
      ? Array.from(key)
      : okLibPipe.hexToByteArray(key); // private key strings are pairs of HEX bytes

  return libOp("OKSETPRIV", (device) => device.loadKey(slot, { type, key: bytes })).then(
    () => done(null, myOnlyKey.getLastMessage("received")),
    (err) => done(reportLibError(err))
  );
};

/*
 * WIPE A KEY SLOT = the lib's device.wipeKey(). keepLabel, because the lib
 * would otherwise also blank the slot's key label - a second write this App
 * never made, into label indices older firmware does not have.
 */
OnlyKey.prototype.wipePrivateKey = function (slot, callback) {
  const done = typeof callback === "function" ? callback : () => {};
  return libOp("OKWIPEPRIV", (device) => device.wipeKey(slot, { keepLabel: true })).then(
    (result) => done(null, result.response),
    (err) => done(reportLibError(err))
  );
};

/*
 * THE DEVICE-WIDE SETTINGS = the lib's device.setPreference(name, value).
 *
 * Every one is OKSETSLOT on slot 0 with one byte, and the lib's table
 * (plugins/device PREFERENCES) knows each field's range and which firmware has
 * it, and waits for the "Successfully set ..." answer. These used to wait for
 * ANY next message (listenforvalue); they now wait for the answer itself.
 */
function setPreferenceField(field, value, callback) {
  const done = typeof callback === "function" ? callback : () => {};
  const name = okLibPipe && okLibPipe.PREFERENCE[field];
  if (!name) return Promise.resolve(done(`no preference for ${field}`));
  return libOp("OKSETSLOT", (device) => device.setPreference(name, value)).then(
    (result) => done(null, result.response),
    (err) => done(reportLibError(err))
  );
}

OnlyKey.prototype.setLockout = function (lockout, callback) {
  setPreferenceField("LOCKOUT", lockout, () => callback());
};

OnlyKey.prototype.setWipeMode = function (wipeMode) {
  return setPreferenceField("WIPEMODE", wipeMode);
};

/*
 * SECOND-PROFILE MODE = the lib's device.setPreference('secProfileMode').
 *
 * On first use the firmware stores it SILENTLY (okcore.cpp set_slot case 23:
 * its hidprint is commented out) and refuses it later with "Second Profile
 * Mode may only be changed on first use", which does not begin "Error". The
 * lib now knows both: it sends the frame once, takes silence as set and
 * returns `confirmed: false`, and throws that sentence as a refusal - where it
 * used to wait out three 10 s attempts on exactly the path the wizard uses,
 * mid PIN bracket (Step4 exitFn).
 *
 * The callback still runs either way, as the raw send's did: the wizard hands
 * it sendSetPin2, which ignores what it is given and continues the bracket.
 * Nothing is added to the list on silence - there is nothing true to say
 * beyond "sent", and the PIN step that follows speaks next. A refusal is on
 * the list already, in the device's words.
 */
OnlyKey.prototype.setSecProfileMode = function (secProfileMode, callback) {
  const done = typeof callback === "function" ? callback : () => {};
  const mode = parseInt(secProfileMode, 10);
  libOp("OKSETSLOT", (device) => device.setPreference("secProfileMode", mode)).then(
    () => done(null, "OK"),
    (err) => done(reportLibError(err))
  );
};

OnlyKey.prototype.setderivedchallengeMode = function (derivedchallengeMode) {
  return setPreferenceField("derivedchallengeMode", derivedchallengeMode);
};

OnlyKey.prototype.setstoredchallengeMode = function (storedchallengeMode) {
  return setPreferenceField("storedchallengeMode", storedchallengeMode);
};

OnlyKey.prototype.setwebAgentDeriveMode = function (webAgentDeriveMode) {
  return setPreferenceField("webAgentDeriveMode", webAgentDeriveMode);
};

OnlyKey.prototype.setwebcryptPolicy = function (webcryptPolicy) {
  return setPreferenceField("webcryptPolicy", webcryptPolicy);
};

OnlyKey.prototype.sethmacchallengeMode = function (hmacchallengeMode) {
  return setPreferenceField("hmacchallengeMode", hmacchallengeMode);
};

OnlyKey.prototype.setmodkeyMode = function (modkeyMode) {
  return setPreferenceField("modkeyMode", modkeyMode);
};

OnlyKey.prototype.setbackupKeyMode = function (backupKeyMode) {
  backupKeyMode = parseInt(backupKeyMode, 10);
  return setPreferenceField("BACKUPKEYMODE", backupKeyMode);
};

OnlyKey.prototype.setTypeSpeed = function (typeSpeed) {
  return setPreferenceField("TYPESPEED", typeSpeed);
};

/* Per slot, so a slot field (lib setSlot typeSpeed), not a preference. */
OnlyKey.prototype.setSlotTypeSpeed = function (slot, typeSpeed) {
  return this.setSlot(slot, "TYPESPEED", typeSpeed);
};

OnlyKey.prototype.setLedBrightness = function (ledBrightness) {
  return setPreferenceField("LEDBRIGHTNESS", ledBrightness);
};

OnlyKey.prototype.setLockButton = function (lockButton) {
  return setPreferenceField("LOCKBUTTON", lockButton);
};

OnlyKey.prototype.setKBDLayout = function (kbdLayout) {
  return setPreferenceField("KBDLAYOUT", kbdLayout);
};

OnlyKey.prototype.setVersion = function (version) {
  this.version = version;
};

OnlyKey.prototype.getVersion = function () {
  return this.version;
};

OnlyKey.prototype.setDeviceType = function (version = "") {
  if (this.getDeviceType()) return; // only allow setting deviceType once
  const lastChar = version[version.length - 1].toLowerCase();
  this.devicePinSet = true;
  let deviceType;

  switch (lastChar) {
    case "n":
      this.devicePinSet = false;
      deviceType = DEVICE_TYPES.DUO;
      break;
    case "p":
      deviceType = DEVICE_TYPES.DUO;
      break;
    case "c":
      deviceType = DEVICE_TYPES.CLASSIC;
      break;
    default:
      if (version.includes("BOOTLOADER")) {
        deviceType = "UNINITIALIZED";
      } else if (version.includes("INITIALIZED-D")) {
        deviceType = DEVICE_TYPES.DUO;
      } else if (version.includes("INITIALIZED")) {
        deviceType = DEVICE_TYPES.CLASSIC;
      } else {
        window.location.reload();
      }      
    }
  console.info(`Setting deviceType to ${deviceType}`);
  this.deviceType = deviceType;
  onlyKeyConfigWizard.init(this);
  return deviceType;
};

OnlyKey.prototype.getDeviceType = function () {
  return this.deviceType;
};

OnlyKey.prototype.initBootloaderMode = function () {
  this.inBootloader = true;

  /* loadFirmware never called the callback this passed it (it takes none);
   * what the bootloader says afterwards reaches handleMessage through the
   * reader regardless. */
  loadFirmware();
};

OnlyKey.prototype.setInitialized = function (initializedArg) {
  const initialized = initializedArg;
  if (initialized !== this.isInitialized) {
    this.isInitialized = initialized;
    onlyKeyConfigWizard.init(this);
  }
};

var ui = {
  showInitPanel: null,
  showSlotPanel: null,
  showPrefPanel: null,
  showKeysPanel: null,
  showBackupPanel: null,
  showFirmwarePanel: null,
  showAdvancedPanel: null,
  showToolsPanel: null,
  initPanel: null,
  slotPanel: null,
  prefPanel: null,
  keysPanel: null,
  backupPanel: null,
  firmwarePanel: null,
  advancedPanel: null,
  toolsPanel: null,
  slotConfigBtns: null,
  slotConfigForm: null,
  slotConfigDialog: null,
  lockedDialog: null,
  lockedDialogDuo: null,
  workingDialog: null,
  disconnectedDialog: null,
  main: null,
};

var initializeWindow = function () {
  for (var k in ui) {
    var id = k.replace(/([A-Z])/g, "-$1").toLowerCase();
    var element = document.getElementById(id);
    if (!element) {
      throw "Missing UI element: " + k + ", " + id;
    }
    ui[k] = element;

    if (k.indexOf("show") === 0) {
      ui[k].addEventListener("click", toggleConfigPanel);
    }
  }

  ui.yubiAuthForm = document["yubiAuthForm"];
  ui.lockoutForm = document["lockoutForm"];
  ui.typeSpeedForm = document["typeSpeedForm"];
  ui.ledBrightnessForm = document["ledBrightnessForm"];
  ui.lockButtonForm = document["lockButtonForm"];
  ui.keyboardLayoutForm = document["keyboardLayoutForm"];
  ui.eccForm = document["eccForm"];
  ui.rsaForm = document["rsaForm"];
  ui.backupForm = document["backupForm"];
  ui.restoreForm = document["restoreForm"];
  ui.firmwareForm = document["firmwareForm"];

  ui.getLockedDialog = (ok) =>
    ok.getDeviceType() === DEVICE_TYPES.DUO
      ? ui.lockedDialogDuo
      : ui.lockedDialog;

  enableIOControls(false);
  enableAuthForms();
  enumerateDevices();
};

var enableIOControls = function (ioEnabled) {
  closeSlotConfigForm();

  if (!ioEnabled) {
    ui.main.classList.add("hide");
    if (myOnlyKey.connection === -1) {
      dialog.open(ui.disconnectedDialog);
    }
  }

  if (myOnlyKey.isInitialized) {
    if (myOnlyKey.isLocked) {
      dialog.open(ui.getLockedDialog(myOnlyKey));
    } else if (myOnlyKey.isBootloader) {
      ui.main.classList.remove("hide");
      ui.initPanel.classList.add("hide");
      ui.showInitPanel.classList.remove("hide", "active");
      ui.slotPanel.classList.add("hide");
      ui.showSlotPanel.classList.remove("hide", "active");
      ui.prefPanel.classList.add("hide");
      ui.showPrefPanel.classList.remove("hide", "active");
      ui.keysPanel.classList.add("hide");
      ui.showKeysPanel.classList.remove("hide", "active");
      ui.backupPanel.classList.add("hide");
      ui.backupPanel.classList.remove("active");
      ui.firmwarePanel.classList.remove("hide");
      ui.advancedPanel.classList.add("hide");
      ui.advancedPanel.classList.remove("active");
      ui.toolsPanel.classList.add("hide");
      ui.toolsPanel.classList.remove("active");
      ui.keysPanel.classList.add("hide");
      ui.keysPanel.classList.remove("active");
      ui.showBackupPanel.classList.remove("hide", "active");
      ui.showFirmwarePanel.classList.remove("hide");
      ui.showFirmwarePanel.classList.add("active");
      ui.showAdvancedPanel.classList.remove("hide", "active");
      ui.showToolsPanel.classList.remove("hide", "active");
      dialog.close(ui.getLockedDialog(myOnlyKey));
    } else {
      ui.main.classList.remove("hide");
      ui.initPanel.classList.add("hide");
      ui.showInitPanel.classList.remove("hide", "active");
      ui.slotPanel.classList.remove("hide");
      ui.showSlotPanel.classList.remove("hide");
      ui.showSlotPanel.classList.add("active");
      ui.prefPanel.classList.add("hide");
      ui.showPrefPanel.classList.remove("hide", "active");
      ui.keysPanel.classList.add("hide");
      ui.showKeysPanel.classList.remove("hide", "active");
      ui.backupPanel.classList.add("hide");
      ui.backupPanel.classList.remove("active");
      ui.firmwarePanel.classList.add("hide");
      ui.firmwarePanel.classList.remove("active");
      ui.advancedPanel.classList.add("hide");
      ui.advancedPanel.classList.remove("active");
      ui.toolsPanel.classList.add("hide");
      ui.toolsPanel.classList.remove("active");
      ui.keysPanel.classList.add("hide");
      ui.keysPanel.classList.remove("active");
      ui.showBackupPanel.classList.remove("hide", "active");
      ui.showFirmwarePanel.classList.remove("hide", "active");
      ui.showAdvancedPanel.classList.remove("hide", "active");
      ui.showToolsPanel.classList.remove("hide", "active");
      dialog.close(ui.getLockedDialog(myOnlyKey));
    }
  } else {
    ui.main.classList.remove("hide");
    ui.slotPanel.classList.add("hide");
    ui.slotPanel.classList.remove("active");
    ui.backupPanel.classList.add("hide");
    ui.backupPanel.classList.remove("active");
    ui.firmwarePanel.classList.add("hide");
    ui.firmwarePanel.classList.remove("active");
    ui.advancedPanel.classList.add("hide");
    ui.advancedPanel.classList.remove("active");
    ui.toolsPanel.classList.add("hide");
    ui.toolsPanel.classList.remove("active");
    ui.keysPanel.classList.add("hide");
    ui.keysPanel.classList.remove("active");
    ui.prefPanel.classList.add("hide");
    ui.prefPanel.classList.remove("active");
    ui.initPanel.classList.remove("hide");
    ui.showInitPanel.classList.remove("hide");
    ui.showInitPanel.classList.add("active");
    ui.showSlotPanel.classList.add("hide");
    ui.showPrefPanel.classList.add("hide");
    ui.showKeysPanel.classList.add("hide");
    ui.showBackupPanel.classList.add("hide");
    ui.showAdvancedPanel.classList.add("hide");
    ui.showToolsPanel.classList.add("hide");
    ui.showFirmwarePanel.classList.add("hide");
    dialog.close(ui.getLockedDialog(myOnlyKey));
  }
};

var enumerateDevices = function () {
  for (let d = 0; d < SUPPORTED_DEVICES.length; d++) {
    const { vendorId, productId } = SUPPORTED_DEVICES[d];

    const deviceInfo = {
      vendorId,
      productId,
    };

    console.log(`Checking for devices with vendorId ${vendorId} and productId ${productId}...`);

    chromeHid.getDevices(deviceInfo, onDevicesEnumerated);
  }
};

var onDevicesEnumerated = async function (devices) {
  if (chrome.runtime.lastError) {
    console.error("onDevicesEnumerated ERROR:", chrome.runtime.lastError);
    return;
  }

  if (devices && devices.length) {
    console.info("HID devices found:", devices);
    for (let i in devices) {
      await onDeviceAdded(devices[i]);
    }
    console.info("Connection ID", myOnlyKey.connection);
  }
};

var onDeviceAdded = async function (device) {
  var supportedDevice = getSupportedDevice(device);
  console.info(device.collections[0].usage);
  if (
    supportedDevice &&
    device.collections[0].usagePage == "65451" &&
    device.serialNumber == "1000000000"
  ) {
    await connectDevice(device);
  } else if (supportedDevice && device.serialNumber != "1000000000") {
    //Before Beta 8 fw
    console.info("Beta 8+ device not found, looking for old device");
    await connectDevice(device);
  }
};

/*
 * CONNECT. Hot-plug stays the App's (risk 4): onDeviceAdded decided which
 * collection this is, and this opens it - as the lib stack over a chrome.hid
 * pipe instead of a bare chrome.hid.connect - then does what it always did:
 * working dialog and wizard init (setConnection), set time, enable the UI.
 */
var connectDevice = async function (device) {
  const deviceId = device.deviceId;

  console.info("CONNECTING device:", device);

  dialog.close(ui.disconnectedDialog);
  dialog.open(ui.workingDialog);

  /* A second matching collection replaces the first, as the old
   * chromeHid.connect overwrote myOnlyKey.connection. */
  if (okLib) await closeLib();

  try {
    okLib = await openLib(deviceId);
  } catch (err) {
    console.error("ERROR CONNECTING:", err);
    return;
  }

  myOnlyKey.setConnection(okLib.pipe.connectionId);
  myOnlyKey.setTime(handleMessage);
  enableIOControls(true);
};

/** Build the lib stack over this collection and attach the App's reader. */
async function openLib(deviceId) {
  if (!okLibPipe) {
    throw new Error("node-onlykey-lib is not available (it needs NW.js require)");
  }
  const pipe = okLibPipe.createChromeHidPipe({
    chromeHid,
    deviceId,
    lastError: () => chrome.runtime.lastError,
    /* made HERE, in the page's context - see libPipe.js on why */
    toArrayBuffer: (bytes) => new Uint8Array(bytes).buffer,
    onReceiveError: (err) => {
      myOnlyKey.setLastMessage("received", "[error]");
      handleMessage(err);
    },
  });
  const app = await okLibPipe.composeLibStack({ pipe });
  const { transport, device } = app.services;
  /*
   * Subscribed FIRST, before any lib operation can subscribe, so for every
   * report the App has recorded it (and counted it as a reply to whatever is
   * in flight) before the lib's own waiter resolves on it.
   */
  const off = transport.on("report", (event) => {
    if (event.iface === okLibPipe.IFACE.VENDOR) onVendorReport(event.data);
  });
  return { app, pipe, transport, device, off };
}

/** Tear the stack down; stopping the pipe is the chrome.hid.disconnect. */
async function closeLib() {
  const lib = okLib;
  okLib = null;
  oneShotListeners.length = 0;
  setTimeWaiters = null;
  if (!lib) return;
  lib.off();
  await lib.app.destroy().catch((err) => console.warn("DISCONNECT ERROR:", err));
}

var onDeviceRemoved = async function () {
  console.info(
    "ONDEVICEREMOVED was triggered with connectionId",
    myOnlyKey.connection
  );
  if (myOnlyKey.connection === -1 && !okLib) return handleDisconnect();

  await closeLib();
  console.info("DISCONNECTED CONNECTION", myOnlyKey.connection);
  handleDisconnect();
};

function handleDisconnect() {
  myOnlyKey.setConnection(-1);
  delete myOnlyKey.deviceType;
  myOnlyKey.setLastMessage("received", "Disconnected");
  onlyKeyConfigWizard.initForm.reset();
  enableIOControls(false);
}

/*
 * EVERY VENDOR REPORT, from the one reader. This is what pollForInput did to
 * each message it read, minus the reading:
 *
 *   - decode it the App's way (readBytes) and learn the device type from it
 *   - put it on the last-message list, which is what the UI shows and what
 *     sendPin_DUO, handleGetLabels and checkForNewFW branch on (risk 1)
 *   - the version / lock-state bookkeeping for UNINITIALIZED, UNLOCKED and
 *     INITIALIZED-D, including the DUO config-mode path
 *   - then hand it on: to a listen() caller if one is waiting, else to
 *     handleMessage if no lib operation is waiting on it, else to nobody -
 *     the lib operation that asked for it has it.
 *
 * That last rule is decided when the report ARRIVES, and the recording is
 * done at once; only the bookkeeping and the hand-off are queued, in arrival
 * order, because the first UNLOCKED waits on a network firmware check
 * (checkForNewFW) and the old reader did not read on while it did.
 */
let reportChain = Promise.resolve();

function onVendorReport(data) {
  const msg = readBytes(new Uint8Array(Array.from(data)));
  const listener = oneShotListeners.shift();
  const route = listener || (libBusy === 0 ? handleMessage : null);
  const flushing = myOnlyKey.flushing;

  console.info(`RECEIVED: ${msg}\nLast message sent: ${myOnlyKey.getLastMessage('sent')}`);
  /* The old reader called this on every message and it threw on an empty one. */
  if (msg) myOnlyKey.setDeviceType(msg);

  if (msg.length > 1 && msg !== "OK" && !flushing) {
    myOnlyKey.setLastMessage("received", msg);
  }

  /* The lib's capabilities follow the version the key reports once unlocked. */
  if (okLib && msg.indexOf("UNLOCKED") >= 0) okLib.device.observeStatus(msg);

  reportChain = reportChain
    .then(() => afterReport(msg, route))
    .catch((err) => console.error("Handling a device message failed:", err));
}

async function afterReport(msg, route) {
  const callback = typeof route === "function" ? route : () => {};
  let version;

  // if message begins with Error, call callback with msg as err
  // and the last sent message as 2nd arg
  if (msg.indexOf("Error") === 0 || msg.indexOf("ERROR") === 0) {
    return callback(msg, myOnlyKey.getLastMessage("sent"));
  } else if (msg.indexOf("UNINITIALIZEDv") >= 0) {
    myOnlyKey.fwUpdateSupport = true;
    version = msg.split("UNINITIALIZED").pop();
    handleVersion(version);
    desktopApp &&
      (await checkForNewFW(
        userPreferences.autoUpdateFW,
        myOnlyKey.fwUpdateSupport,
        version
      ));
  } else if (msg.indexOf("UNINITIALIZED") >= 0) {
    myOnlyKey.fwUpdateSupport = false;
    version = "v0.2-beta.6";
    var upgradetext = document.getElementById("upgrade-text");
    upgradetext.innerHTML =
      "This application is designed to work with a newer version of OnlyKey firmware. <br>Go to https://docs.crp.to/upgradeguide.html ";
    handleVersion(version);
    desktopApp &&
      (await checkForNewFW(
        userPreferences.autoUpdateFW,
        myOnlyKey.fwUpdateSupport,
        version
      ));
    return;
  } else if (msg.indexOf("UNLOCKED") >= 0) {
    version = msg.split("UNLOCKED").pop();
    handleVersion(version);
    if (version && (version[9] != "." || version[10] > 6)) {
      //Firmware update through app supported
      myOnlyKey.fwUpdateSupport = true;
    }
    desktopApp &&
      (await checkForNewFW(
        userPreferences.autoUpdateFW,
        myOnlyKey.fwUpdateSupport,
        version
      ));
    if (myOnlyKey.isConfigMode == true) {
      myOnlyKey.isLocked = false;
      enableIOControls(true);
    }
  } else if (msg.indexOf("INITIALIZED-D") >= 0) {
    if (myOnlyKey.isLocked == false || myOnlyKey.isConfigMode == true) { // Device was unlocked, now its locked, user is putting device in Config Mode
      myOnlyKey.isLocked = true;
      myOnlyKey.isConfigMode = true;
      myOnlyKey.setTime(handleMessage);
      enableIOControls(true);
    } else {
      myOnlyKey.isLocked = true;
      myOnlyKey.setInitialized(true);
    }
  }

  return await callback(null, msg);
}

/*
 * A lib reply that the old code would have read into handleMessage - the
 * answer to a key write that was followed by listen(handleMessage), or a DUO
 * unlock attempt. Errors go in as errors, the way the reader delivered them.
 */
function routeToHandleMessage(msg) {
  if (msg.indexOf("Error") === 0 || msg.indexOf("ERROR") === 0) {
    return handleMessage(msg, myOnlyKey.getLastMessage("sent"));
  }
  return handleMessage(null, msg);
}

var readBytes = function (bytes) {
  var msgStr = "";
  var msgBytes = new Uint8Array(bytes.buffer);

  for (var i = 0; i < msgBytes.length; i++) {
    if (msgBytes[i] > 31 && msgBytes[i] < 127)
      msgStr += String.fromCharCode(msgBytes[i]);
    else if (i === 0)
      // if first byte is a hex, this is probably a slot number
      msgStr += byteToHex(msgBytes[i]);
  }

  return msgStr;
};

var handleMessage = async function (err, msg) {
  if (err) {
    return console.error("MESSAGE ERROR:", err);
  }

  msg = msg.trim();
  var updateUI = false;
  var version;
  dialog.close(ui.workingDialog);

  const indexOfInitialized = msg.indexOf("INITIALIZED");

  switch (true) {
    case indexOfInitialized >= 0:
      myOnlyKey.setInitialized(indexOfInitialized === 0);
      updateUI = true;

      // special handling if last message sent was PIN-related
      if (myOnlyKey.getDeviceType() === DEVICE_TYPES.CLASSIC) {
        switch (myOnlyKey.getLastMessage("sent")) {
          case "OKSETPIN":
          case "OKSETPIN2":
          case "OKSETSDPIN":
            // Ignored mid-bracket. This used to re-arm the reader here; the
            // reader is continuous now, so returning is all that is left.
            return;
        }
      }
      break;
    default:
      break;
  }

  // A locked key (INITIALIZED at 0) used to have the reader re-armed here so
  // its once-a-second status kept arriving; the reader never stops now.

  if (msg.replace(/\s/g, "").indexOf("UNINITIALIZEDv") >= 0) {
    myOnlyKey.fwUpdateSupport = true;
    version = msg.split("UNINITIALIZED").pop();
    handleVersion(version);
    updateUI = true;
    myOnlyKey.fwUpdateSupport = true;
  } else if (msg.indexOf("BOOTLOADER") >= 0) {
    myOnlyKey.setInitialized(true);
    myOnlyKey.isBootloader = true;
    myOnlyKey.isLocked = false;
    version = msg.split("UNLOCKED").pop();
    handleVersion(version);
    updateUI = true;
    myOnlyKey.fwUpdateSupport = true;
    myOnlyKey.initBootloaderMode();
  } else if (msg.indexOf("UNLOCKED") >= 0) {
    if (myOnlyKey.getLastMessage("sent") === "OKSETPRIV") {
      // Not an unlock: a status during a key write. It used to be skipped by
      // re-arming the reader; the reader is continuous, so it is just skipped.
    } else {
      myOnlyKey.setInitialized(true);
      version = msg.split("UNLOCKED").pop();
      handleVersion(version);
      if (version && (version[9] != "." || version[10] > 6)) {
        //Firmware update through app supported
        myOnlyKey.fwUpdateSupport = true;
      }
      if (myOnlyKey.isLocked) {
        myOnlyKey.isLocked = false;
        myOnlyKey.setTime(myOnlyKey.getLabels.bind(myOnlyKey));
        updateUI = true;
      }
    }
  } else if (msg.indexOf("LOCKED") >= 0) {
    myOnlyKey.isLocked = true;
  }

  var firmwaretext = document.getElementById("firmware-text");
  var step8text = document.getElementById("step8-text");
  var step9text = document.getElementById("step9-text");
  if (myOnlyKey.isBootloader || !myOnlyKey.isInitialized) {
    //Firmware load in app without config mode
    firmwaretext.innerHTML =
      "To load a new firmware file to your OnlyKey, click [Choose File], select your firmware file, then click [Next].</p><p>The OnlyKey will restart automatically when firmware load is complete.";
    step8text.innerHTML = " ";
    step9text.innerHTML = " ";
  } else if (myOnlyKey.fwUpdateSupport) {
    //Firmware load in app with config mode
    firmwaretext.innerHTML =
      `<p><u>Step 1</u>.
      <span class="device-specific ok-classic">Hold down button #6 on your OnlyKey for 5+ seconds and release.</span>
      <span class="device-specific ok-duo">Hold down button #1 on your OnlyKey DUO for 10+ seconds and release.</span>
      The light will turn off. If a PIN was previously set, re-enter the PIN to enter config mode.
      You will notice the OnlyKey flashes red in config mode.</p>
      <p><u>Step 2</u>. Click [Choose File], select your firmware file, then click [Load Firmware to OnlyKey].</p>
      <p><u>Step 3</u>. The OnlyKey will flash white while loading your firmware, then will restart automatically when firmware load is complete.</p>`;
    step8text.innerHTML =
      "To set a new passphrase on your OnlyKey put OnlyKey in config mode. For OnlyKey hold down button #6 on your OnlyKey for 5+ seconds and release. For OnlyKey DUO hold down button #1 on your OnlyKey for 10+ seconds and release. The light will turn off and if a PIN has been set re-enter your PIN to enter config mode. You will notice the OnlyKey flashes red in config mode.</p>";
    step9text.innerHTML =
      "To set a new passphrase on your OnlyKey put OnlyKey in config mode. For OnlyKey hold down button #6 on your OnlyKey for 5+ seconds and release. For OnlyKey DUO hold down button #1 on your OnlyKey for 10+ seconds and release. The light will turn off and if a PIN has been set re-enter your PIN to enter config mode. You will notice the OnlyKey flashes red in config mode.</p>";
  } else {
    //Firmware load not supported in app
    firmwaretext.innerHTML =
      "This version of firmware is outdated and does not support this feature. To load latest firmware follow the loading instructions <a href='https://docs.crp.to/usersguide.html#loading-onlykey-firmware' class='external'>here</a>";
    step8text.innerHTML =
      "This version of firmware is outdated and does not support this feature. To load latest firmware follow the loading instructions <a href='https://docs.crp.to/usersguide.html#loading-onlykey-firmware' class='external'>here</a>";
  }

  if (updateUI) {
    enableIOControls(true);
  }
};

function init() {
  console.info("OnlyKeyComm init() called");
  initializeWindow();
  myOnlyKey.setConnection(-1);
  chromeHid.onDeviceAdded.addListener(onDeviceAdded);
  chromeHid.onDeviceRemoved.addListener(onDeviceRemoved);
}

function toggleConfigPanel(e) {
  var clicked = this;
  var panels = {
    init: "Init",
    slot: "Slot",
    pref: "Pref",
    keys: "Keys",
    backup: "Backup",
    firmware: "Firmware",
    advanced: "Advanced",
    tools: "Tools",
  };
  var hiddenClass = "hide";
  var activeClass = "active";
  for (var panel in panels) {
    if (clicked.id.indexOf(panel) >= 0) {
      if (!clicked.classList.contains(activeClass)) {
        onlyKeyConfigWizard.reset();
        ui[panel + "Panel"].classList.remove(hiddenClass);
        ui["show" + panels[panel] + "Panel"].classList.add(activeClass);
      }
    } else {
      ui[panel + "Panel"].classList.add(hiddenClass);
      ui["show" + panels[panel] + "Panel"].classList.remove(activeClass);
    }
  }
  e && e.preventDefault && e.preventDefault();
}

function initSlotConfigForm() {
  const deviceType = myOnlyKey.getDeviceType();
  const deviceBtns = ui.slotConfigBtns.getElementsByClassName(`ok-${deviceType}`)[0];
  const configBtns = Array.from(deviceBtns.getElementsByTagName('input'));
  configBtns.forEach((btn, i) => {
    const slotId = btn.dataset.slotId || btn.value; // prefer data-slot-id
    const labelIndex = myOnlyKey.getSlotNum(slotId);
    const labelText = myOnlyKey.labels[labelIndex - 1] || 'empty';
    onlyKeyConfigWizard.setSlotLabel(i, labelText);
    btn.addEventListener('click', showSlotConfigForm);
  });
  ui.slotConfigDialog
    .getElementsByClassName('slot-config-close')[0]
    .addEventListener('click', closeSlotConfigForm);
  ui.slotConfigDialog.addEventListener('close', () => {
    document.getElementById('slotConfigErrors').innerHTML = '';
    ui.slotConfigForm.reset()
  });
}

function showSlotConfigForm(e) {
  const slotId = e.target.value;
  const slotUniqueId = e.target.dataset.slotId || e.target.value; // prefer "data-slot-id" attribute
  myOnlyKey.currentSlotId = slotUniqueId;
  const deviceSlots = document.getElementById(`${myOnlyKey.deviceType}-slots`);
  const slotLabel = deviceSlots.querySelector(`#slotLabel${slotUniqueId}`).innerText;
  ui.slotConfigDialog.getElementsByClassName('slotId')[0].innerText = slotId;

  document.getElementById('txtSlotLabel').value =
    slotLabel.toLowerCase() === 'empty' ? '' : slotLabel;
  dialog.open(ui.slotConfigDialog);
  initSlotConfigForm();
  e && e.preventDefault && e.preventDefault();
}

function closeSlotConfigForm(e) {
  dialog.close(ui.slotConfigDialog);
  e && e.preventDefault && e.preventDefault();
}

function enableAuthForms() {
  var yubiSubmit = document.getElementById("yubiSubmit");
  var yubiWipe = document.getElementById("yubiWipe");
  yubiSubmit.addEventListener("click", submitYubiAuthForm);
  yubiWipe.addEventListener("click", wipeYubiAuthForm);

  var lockoutSubmit = document.getElementById("lockoutSubmit");
  lockoutSubmit.addEventListener("click", submitLockout);

  const fullWipeModeBtn = document.getElementById("fullWipeModeBtn");
  fullWipeModeBtn.addEventListener("click", (e) => submitWipeMode(e, 2));

  const backupModeBtn = document.getElementById("backupModeBtn");
  backupModeBtn.addEventListener("click", (e) => submitBackupMode(e, 1));

  // The stored-key mode is now a radio group in the User Input Modes form
  // above, alongside the other two families, instead of its own pair of
  // buttons - one setting per key family, set and saved the same way.

  const userInputModesSaveBtn = document.getElementById("userInputModesSaveBtn");
  userInputModesSaveBtn.addEventListener("click", (e) => submitUserInputModes(e));

  const webcryptPolicySaveBtn = document.getElementById("webcryptPolicySaveBtn");
  webcryptPolicySaveBtn.addEventListener("click", (e) => submitWebcryptPolicy(e));

  const disableModkeyModeBtn = document.getElementById("disableModkeyModeBtn");
  disableModkeyModeBtn.addEventListener("click", (e) => submitmodkeyMode(e, 0));
  const enableModkeyModeBtn = document.getElementById("enableModkeyModeBtn");
  enableModkeyModeBtn.addEventListener("click", (e) => submitmodkeyMode(e, 1));

  const disableHmacBtnPressBtn = document.getElementById("disableHmacBtnPressBtn");
  disableHmacBtnPressBtn.addEventListener("click", (e) => submithmacchallengeMode(e, 0));
  const enableHmacBtnPressBtn = document.getElementById("enableHmacBtnPressBtn");
  enableHmacBtnPressBtn.addEventListener("click", (e) => submithmacchallengeMode(e, 1));

  var typeSpeedSubmit = document.getElementById("typeSpeedSubmit");
  typeSpeedSubmit.addEventListener("click", submitTypeSpeed);

  var ledBrightnessSubmit = document.getElementById("ledBrightnessSubmit");
  ledBrightnessSubmit.addEventListener("click", submitLedBrightness);

  var lockButtonSubmit = document.getElementById("lockButtonSubmit");
  lockButtonSubmit.addEventListener("click", submitLockButton);

  var kbdLayoutSubmit = document.getElementById("kbdLayoutSubmit");
  kbdLayoutSubmit.addEventListener("click", submitKBDLayout);

  var eccSubmit = document.getElementById("eccSubmit");
  eccSubmit.addEventListener("click", submitEccForm);
  ui.eccForm.setError = function (errString) {
    document.getElementById("eccFormError").innerText = errString;
  };

  var eccWipe = document.getElementById("eccWipe");
  eccWipe.addEventListener("click", wipeEccKeyForm);

  var rsaSubmit = document.getElementById("rsaSubmit");
  rsaSubmit.addEventListener("click", submitRsaForm);
  ui.rsaForm.setError = function (errString) {
    document.getElementById("rsaFormError").innerText = errString;
  };

  var rsaWipe = document.getElementById("rsaWipe");
  rsaWipe.addEventListener("click", wipeRsaKey);

  var backupSave = document.getElementById("backupSave");
  backupSave.addEventListener("click", saveBackupFile);
  ui.backupForm.setError = function (errString) {
    document.getElementById("backupFormError").innerText = errString;
  };

  var backupVerify = document.getElementById("backupVerify");
  backupVerify.addEventListener("click", verifyBackupFile);
  ui.backupForm.setError = function (errString) {
    document.getElementById("backupFormError").innerText = errString;
  };

  var restoreFromBackup = document.getElementById("doRestore");
  restoreFromBackup.addEventListener("click", submitRestoreForm);
  ui.restoreForm.setError = function (errString) {
    document.getElementById("restoreFormError").innerText = errString;
  };

  var loadFirmware = document.getElementById("doFirmware");
  loadFirmware.addEventListener("click", submitFirmwareForm);
  ui.firmwareForm.setError = function (errString) {
    document.getElementById("firmwareFormError").innerText = errString;
  };

  ui.backupForm.setError("");
  ui.backupForm.reset();
  ui.restoreForm.setError("");
  ui.restoreForm.reset();
  ui.firmwareForm.setError("");
  ui.firmwareForm.reset();
}

function submitYubiAuthForm(e) {
  var publicId = ui.yubiAuthForm.yubiPublicId.value || "";
  var privateId = ui.yubiAuthForm.yubiPrivateId.value || "";
  var secretKey = ui.yubiAuthForm.yubiSecretKey.value || "";

  publicId = publicId.toString().replace(/\s/g, "");
  privateId = privateId.toString().replace(/\s/g, "");
  secretKey = secretKey.toString().replace(/\s/g, "");

  // going to be mean and only send the max chars allowed
  var maxPublicIdLength = 12; // 6 bytes
  var maxPrivateIdLength = 12; // 6 bytes
  var maxSecretKeyLength = 32; // 64 bytes
  publicId = hexToModhex(publicId.slice(0, maxPublicIdLength), true);
  privateId = privateId.slice(0, maxPrivateIdLength);
  secretKey = secretKey.slice(0, maxSecretKeyLength);

  // TODO: validation
  myOnlyKey.setYubiAuth(publicId, privateId, secretKey, function (err) {
    // TODO: check for success, then reset
    ui.yubiAuthForm.reset();
  });

  e && e.preventDefault && e.preventDefault();
}

function wipeYubiAuthForm(e) {
  myOnlyKey.wipeYubiAuth();
  e && e.preventDefault && e.preventDefault();
}

function submitEccForm(e) {
  ui.eccForm.setError("");

  var type = parseInt(ui.eccForm.eccType.value || "", 10);
  var slot = parseInt(ui.eccForm.eccSlot.value || "", 10);
  var key = ui.eccForm.eccKey.value || "";

  var maxKeyLength = 64; // 32 hex pairs

  var priv_type = "ECC";

  if (type == 9) {
    maxKeyLength = 40; // 20 hex pairs
    priv_type = "HMAC";
  }

  key = key.toString().replace(/\s/g, "").slice(0, maxKeyLength);

  if (!key) {
    return ui.eccForm.setError(
      priv_type + " Key cannot be empty. Use [Wipe] to clear a key."
    );
  }

  if (key.length !== maxKeyLength) {
    return ui.eccForm.setError(
      priv_type + " Key must be " + maxKeyLength + " characters."
    );
  }

  // set all type modifiers
  var typeModifier = 0;

  Object.keys(myOnlyKey.keyTypeModifiers).forEach(function (modifier) {
    if (ui.eccForm["eccSetAs" + modifier].checked) {
      typeModifier += myOnlyKey.keyTypeModifiers[modifier];
    }
  });

  type += typeModifier;

  myOnlyKey.setPrivateKey(slot, type, key, function (err, msg) {
    // The answer, which the lib waited for, is what listen(handleMessage) read.
    handleMessage(err, msg);
    ui.eccForm.reset();
  });

  e && e.preventDefault && e.preventDefault();
}

function wipeEccKeyForm(e) {
  ui.eccForm.setError("");

  var slot = parseInt(ui.eccForm.eccSlot.value || "", 10);
  myOnlyKey.wipePrivateKey(slot, function (err, msg) {
    handleMessage(err, msg);
  });

  e && e.preventDefault && e.preventDefault();
}

async function submitRsaForm(e) {
  e && e.preventDefault && e.preventDefault();
  ui.rsaForm.setError("");

  var key = ui.rsaForm.rsaKey.value || "";
  var passcode = ui.rsaForm.rsaPasscode.value || "";

  if (!key) {
    return ui.rsaForm.setError(
      "Key cannot be empty. Use [Wipe] to clear a key."
    );
  }
  if (key.includes("-----") && !key.includes("-----BEGIN PGP")) {
    var sshpk = require("sshpk");
    try {
      var allKeys = sshpk.parsePrivateKey(key, "pem", { passphrase: passcode });
    } catch (e) {
      return ui.rsaForm.setError("Error parsing SSH key: " + e.message);
    }
  } else {
    if (!passcode) {
      return ui.rsaForm.setError("Passcode cannot be empty.");
    }

    var privKey,
      keyObj = {},
      retKey;

    try {
      var privKeys = await openpgp.key.readArmored(key);
      privKey = privKeys.keys[0];

      var success = await privKey.decrypt(passcode);
      if (!success) {
        throw new Error(
          "Private Key decryption failed. Did you forget your passcode?"
        );
      }

      //console.info(privKey.primaryKey);
      //console.info(privKey.primaryKey.params);
      //console.info(privKey.primaryKey.params.length);

      if (!(privKey.primaryKey && privKey.primaryKey.params)) {
        throw new Error(
          "Key decryption was successful, but resulted in invalid data. Is this a valid OpenPGP key?"
        );
      }
    } catch (e) {
      return ui.rsaForm.setError("Error parsing PGP key: " + e.message);
    }

    var allKeys = {
      primaryKey: privKey.primaryKey,
      subKeys: privKey.subKeys,
    };
  }

  await onlyKeyConfigWizard.initKeySelect(allKeys, function (err) {
    ui.rsaForm.setError(err || "");
  });
}

OnlyKey.prototype.confirmRsaKeySelect = function (keyObj, slot, cb) {
  if (typeof keyObj.s !== "undefined") {
    //ECC
    var type = myOnlyKey.tempEccCurve;
    if (type == 0) {
      return ui.rsaForm.setError(
        "Unsupported ECC key type, key is not X25519 or NIST256p1."
      );
    }

    if (keyObj.s.length != 32) {
      return ui.rsaForm.setError("Selected key length should be 32 bytes.");
    }

    var retKey = Array.from(keyObj.s);
  } else {
    //RSA
    var type = parseInt(keyObj.p.length / 64, 10);

    if ([1, 2, 3, 4].indexOf(type) < 0) {
      return ui.rsaForm.setError(
        "Selected key length should be 1024, 2048, 3072, or 4096 bits."
      );
    }

    var retKey = [...keyObj.p, ...keyObj.q];
  }
  var slot =
    slot !== null ? slot : parseInt(ui.rsaForm.rsaSlot.value || "", 10);

  // set all type modifiers
  var typeModifier = 0;

  Object.keys(myOnlyKey.keyTypeModifiers).forEach(function (modifier) {
    if (
      ui.rsaForm["rsaSetAs" + modifier] &&
      ui.rsaForm["rsaSetAs" + modifier].checked
    ) {
      typeModifier += myOnlyKey.keyTypeModifiers[modifier];
    }
  });

  type += typeModifier;

  if (document.getElementById("rsaSlot").value === "99") {
    if (slot == 1) {
      type += 32;
      console.info("Slot 1 set as decryption key" + type);
    }
    if (slot == 2) {
      if (type > 127) type -= 128; // Only set backup flag on decryption key
      type += 64;
      console.info("Slot 2 set as signature key" + type);
    }
  }
  if (typeof keyObj.s !== "undefined") {
    //ECC
    if (slot < 101) slot += 100;
    myOnlyKey.setPrivateKey(slot, type, retKey, (err, msg) => {
      // TODO: check for success, then reset
      if (typeof cb === "function") cb(err);
      ui.rsaForm.reset();
      if (backupsigFlag >= 0) {
        backupsigFlag = -1;
        //reset backup form
      }
      handleMessage(err, msg);
    });
  } else {
    submitRsaKey(slot, type, retKey, (err, msg) => {
      // TODO: check for success, then reset
      if (typeof cb === "function") cb(err);
      ui.rsaForm.reset();
      if (backupsigFlag >= 0) {
        backupsigFlag = -1;
        //reset backup form
      }
      handleMessage(err, msg);
    });
  }
};

function submitRsaKey(slot, type, key, callback) {
  if (!Array.isArray(key)) {
    return callback("Invalid key format.");
  }
  // The lib's loadKey sends p||q as the same 57-byte OKSETPRIV chunks this
  // used to send one by one, and then waits for the device's one answer.
  myOnlyKey.setPrivateKey(slot, type, key, callback);
}

function saveBackupFile(e) {
  e && e.preventDefault && e.preventDefault();
  ui.backupForm.setError("");

  const backupData = ui.backupForm.backupData.value.trim();
  if (backupData) {
    const d = new Date();
    const dYear = d.getFullYear(),
          dMonth = strPad(d.getMonth() + 1, 2, 0),
          dDate = strPad(d.getDate(), 2, 0),          
          dHour = strPad(d.getHours(), 2, 0),
          dMinutes = strPad(d.getMinutes(), 2, 0);

    const df = `${dYear}-${dMonth}-${dDate}T${dHour}-${dMinutes}`;
          
    // format as onlykey-backup-2022-01-31T22-09.txt
    const filename = `onlykey-backup-${df}.txt`;
    const blob = new Blob([backupData], {
      type: "text/plain;charset=utf-8",
    });
    saveAs(blob, filename); // REQUIRES FileSaver.js polyfill

    document.getElementById("lastBackupFilename").innerText = filename;
    ui.backupForm.reset();
  } else {
    ui.backupForm.setError("Backup data cannot be empty space.");
  }
  document.getElementById("verifyBackupMessage").innerText = "";
}

function verifyBackupFile(e) {
  e && e.preventDefault && e.preventDefault();
  ui.backupForm.setError("");
  document.getElementById("verifyBackupMessage").innerText = "";
  var backupData = ui.backupForm.backupData.value.trim();
  if (backupData) {
    try {
      var backuphash = new Uint8Array(32).fill(0);
      var doesfwsupport;
      backupData.split("\n").forEach(function (line) {
        var sha256 = require('js-sha256');
        var hash = sha256.create();
        if (!line.includes("--")) {
          var valuetohash = hexStringtoByteArray(base64tohex(line));
          console.info("line to hash", valuetohash);
          hash.update(backuphash);
          hash.update(valuetohash);
          backuphash = hash.array();
          console.info("current hash", hash.hex());
        } else if (!line.includes("BACKUP")) { // This line is --<sha256hash>
          //TODO test that filebackuphash and backuphash are the same, if not backup is corrupt
          console.info("File hash", line.slice(2, line.length));
          var filebackuphash = base64tohex(line.slice(2, line.length)); // sha256 hash is 32 bytes
          console.info("computed backup hash", arraytoHexString(backuphash));
          console.info("file backup hash", filebackuphash);
          if (filebackuphash === arraytoHexString(backuphash).toUpperCase()) {
            document.getElementById("verifyBackupMessage").innerText = "Successfully verified backup SHA256 hash";
          } else {
            ui.backupForm.setError("ERROR this backup file is corrupt");
          }
          doesfwsupport = true;
        } 
      });
      if (!doesfwsupport) {
        ui.backupForm.setError("ERROR this backup file does not support verification");
      }
    } catch (parseError) {
      ui.backupForm.setError("ERROR this backup file is corrupt");
    }
  } else {
    ui.backupForm.setError("Backup data cannot be empty space.");
  }
}

function submitRestoreForm(e) {
  e && e.preventDefault && e.preventDefault();
  ui.restoreForm.setError("");

  var fileSelector = ui.restoreForm.restoreSelectFile;
  if (fileSelector.files && fileSelector.files.length) {
    var file = fileSelector.files[0];
    var reader = new FileReader();

    reader.onload = (function (theFile) {
      return function (e) {
        //console.info("RESULT:", e.target.result);
        var text = e.target && e.target.result && e.target.result.trim();
        var contents;
        try {
          contents = parseBackupData(text);
        } catch (parseError) {
          return ui.restoreForm.setError(
            "Could not parse backup file.\n\n" + parseError
          );
        }

        if (contents) {
          var restoretext = document.getElementById("restore-text");
          restoretext.innerHTML =
            "Restoring from backup please wait...<br><br>" +
            "<img src='/images/Pacman-0.8s-200px.gif' height='40' width='40'><br><br>";
          // The lib's restore - see OnlyKey.prototype.submitRestore for the two
          // deliberate differences (a wrong digest is refused; none is allowed).
          libOp("OKRESTORE", (device) => device.restore(text, { unverifiable: true })).then(
            async () => {
              await wait(10000);
              ui.restoreForm.reset();
              restoretext.innerHTML = "";
            },
            (err) => {
              restoretext.innerHTML = "";
              ui.restoreForm.setError(reportLibError(err));
            }
          );
        } else {
          return ui.restoreForm.setError("Incorrect backup data format.");
        }
      };
    })(file);

    // Read in the image file as a data URL.
    reader.readAsText(file);
  } else {
    ui.restoreForm.setError("Please select a file first.");
  }
}

function submitFirmwareForm(e) {
  e && e.preventDefault && e.preventDefault();

  ui.firmwareForm.setError("");
  var fileSelector = ui.firmwareForm.firmwareSelectFile;

  if (fileSelector.files && fileSelector.files.length) {
    var file = fileSelector.files[0];
    var reader = new FileReader();

    reader.onload = (function (theFile) {
      return async function (e) {
        let contents = e.target && e.target.result && e.target.result.trim();

        try {
          console.info("unparsed contents", contents);
          contents = parseFirmwareData(contents);
          console.info("parsed contents", contents);
        } catch (parseError) {
          return ui.firmwareForm.setError(
            "Could not parse firmware file.\n\n" + parseError
          );
        }

        if (contents) {
          onlyKeyConfigWizard.newFirmware = contents;
          if (!myOnlyKey.isBootloader) {
            ui.firmwareForm.setError("Working... Do not remove OnlyKey");

            //First send one message to kick OnlyKey (in config mode) into bootloader
            requestFirmwareLoad(() => {
              ui.firmwareForm.reset();
              ui.firmwareForm.setError("Firmware file sent to OnlyKey");
            });
          } else {
            await loadFirmware();
          }
        } else {
          return ui.firmwareForm.setError("Incorrect firmware data format.");
        }
      };
    })(file);

    // Read in the image file as a data URL.
    reader.readAsText(file);
  } else {
    ui.firmwareForm.setError("Please select a file first.");
  }
}

/*
 * THE FIRMWARE-LOAD REQUEST = the lib's device.requestFirmwareUpdate().
 *
 * One OKFWUPDATE carrying "1234" asks a key in config mode to restart into
 * its bootloader. The three places that start a firmware load (the wizard,
 * the Firmware panel, the update check) all send it, and all used to follow it
 * with listen(handleMessage) for "SUCCESSFULL FW LOAD REQUEST, REBOOTING..."
 * or "Error not in config mode" - so the answer goes to handleMessage here.
 *
 * `onRequested` is what each caller meant to run once the request was
 * accepted. It never ran before: they passed it to submitFirmwareData, which
 * takes no callback. It runs now, on the key's acceptance only.
 *
 * NOT TESTED AGAINST A DEVICE - only against the scripted mock in
 * test/lib/facade.test.js. Never point that at a real key.
 */
function requestFirmwareLoad(onRequested) {
  return libOp("OKFWUPDATE", (device) => device.requestFirmwareUpdate()).then(
    (text) => {
      console.info("Firmware file sent to OnlyKey");
      if (typeof onRequested === "function") onRequested(text);
      routeToHandleMessage(text); //OnlyKey will respond with "SUCCESSFULL FW LOAD REQUEST, REBOOTING..." or "ERROR NOT IN CONFIG MODE"
    },
    (err) => {
      const text = reportLibError(err);
      routeToHandleMessage(/^Error/i.test(text) ? text : `Error ${text}`);
    }
  );
}

/*
 * THE FIRMWARE ITSELF, to a key in its bootloader = the lib's
 * device.sendFirmware(). It sends each block as 57-byte OKFWUPDATE packets,
 * waits for "RECEIVED OKFWUPDATE" after each and for "NEXT BLOCK" /
 * "SUCCESSFULLY LOADED FW" after each block - what loadFirmware and
 * submitFirmwareData did with listenForMessageIncludes. The progress text is
 * the App's, per block as before.
 *
 * The lib takes the file's text; the wizard holds the parsed lines
 * (newFirmware, which parseFirmwareData made by dropping the first and last
 * line), so the text is put back together from them.
 *
 * NOT TESTED AGAINST A DEVICE - see requestFirmwareLoad.
 */
async function loadFirmware() {
  const firmwaretext = document.getElementById("firmware-text");
  const lines = onlyKeyConfigWizard.newFirmware;
  const fwlength = lines && lines.length;

  if (fwlength) {
    // There is a firmware file to load]
    console.info(`Firmware file parsed into ${fwlength} lines.`); //Each line is a block in the blockchain

    const firmwareFile = okLibPipe.lib.device.firmware;
    const text = [firmwareFile.BEGIN]
      .concat(lines.map((line) => line.toString()), [firmwareFile.END])
      .join("\n");
    const showProgress = (done, of) => {
      firmwaretext.innerHTML =
        "Loading Firmware<br><br>" +
        "<img src='/images/Pacman-0.8s-200px.gif' height='40' width='40'><br><br>" +
        Number.parseFloat((done / of) * 100).toFixed(0) +
        " Percent Complete";
    };

    showProgress(0, fwlength);
    try {
      await libOp("OKFWUPDATE", (device) =>
        device.sendFirmware(text, {
          onProgress: ({ block, of, packet, packets }) => {
            if (packet === packets) showProgress(block, of);
          },
        })
      );
      firmwaretext.innerHTML = "Firmware Load Complete!";
      ui.firmwareForm.setError("");
      document.getElementById("firmwareSelectFile").value = "";
      onlyKeyConfigWizard.newFirmware = null;
    } catch (err) {
      console.error(`Error submitting firmware data:`, err);
      return myOnlyKey.setLastMessage("received", errorText(err));
    }

    // After loading firmware OnlyKey will reboot and version will no longer be "BOOTLOADER"
  }
}

/**
 * Use promise and setTimeout to wait x seconds
 */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkForNewFW(checkForNewFW, fwUpdateSupport, version) {
  if (!fwchecked) {
    return new Promise((resolve, reject) => {
      fwchecked = true;
      if (checkForNewFW == true && fwUpdateSupport == true) {
        //fw checking enabled and firmware version supports app updates
        console.info("Checking for new firmware");
        request.get(
          "https://github.com/trustcrypto/OnlyKey-Firmware/releases/latest",
          function (err, res, body) {
            if (err) return reject(err);

            console.log(this.uri.href);
            //var testupgradeurl = 'https://github.com/trustcrypto/OnlyKey-Firmware/releases/tag/v2.1.0-prod'
            //var latestver = testupgradeurl.split("/tag/v"); //end of redirected URL is the version
            var latestver = this.uri.href.split("/tag/v");
            latestver = latestver[1];
            console.info("Current verion", version);
            console.info("Latest verion", latestver);

            var thisver_maj = version.slice(1, 2) * 100;
            console.info(thisver_maj);
            var thisver_min = version.slice(3, 4) * 10;
            console.info(thisver_min);
            if (thisver_maj == 0) {
              var thisver_pat = version.slice(10, 11);
            } else {
              var thisver_pat = version.slice(5, 6);
            }
            var thisver_mod = version.slice(11, 12);
            console.info("Current verion mod", thisver_mod);
            var latestversplit = latestver.split(".")
            console.info(latestversplit);
            var latestver_maj = latestversplit[0] * 100;
            console.info("Latest verion maj", latestver_maj);
            var latestver_min = latestversplit[1] * 10;
            console.info("Latest verion min", latestver_min);
            if (latestver_maj == 0) {
              var latestver_pat = latestver.slice(10, 11);
            } else {
              var latestver_pat = latestversplit[2].split("-");
            }
            latestver_pat = latestver_pat[0];
            console.info("Latest verion pat", latestver_pat);

            if (
              thisver_maj + thisver_min + thisver_pat <
              latestver_maj + latestver_min + latestver_pat
            ) {
              if (version[9] != "." || version[10] > 6) {
                if (thisver_mod == "c" || thisver_mod == "g") {
                  if (
                    window.confirm(
                      "A new version of firware is available. Would you like to review the upgrade guide?"
                    )
                  ) {
                    const openMethod =
                      typeof nw === "undefined"
                        ? window.open
                        : nw.Shell.openExternal;
                    openMethod("https://docs.crp.to/upgradeguide.html");
                    if (
                      window.confirm(
                        "After reading the upgrade guide click OK to automatically download and install the latest standard edition OnlyKey firmware"
                      )
                    ) {
                      // Download latest standard firmware for color from URL
                      // https://github.com/trustcrypto/OnlyKey-Firmware/releases/download/
                      var downloadurl =
                        "https://github.com/trustcrypto/OnlyKey-Firmware/releases/download/" +
                        "v" + latestver +
                        "/Signed_OnlyKey_";
                      downloadurl = downloadurl +
                          latestver_maj / 100 +
                          "_" +
                          latestver_min / 10 +
                          "_" +
                          latestver_pat +
                          "_STD.txt";
                      console.info(downloadurl);
                      var req = request.get(
                        downloadurl,
                        async function (err, res, body) {
                          console.info(myOnlyKey.getLastMessage("received"));
                          if (
                            myOnlyKey
                              .getLastMessage("received")
                              .indexOf("UNINITIALIZEDv") >= 0 ||
                            window.confirm(
                              "To load new firmware file to your OnlyKey put OnlyKey in config mode. For OnlyKey hold down button #6 on your OnlyKey for 5+ seconds and release. For OnlyKey DUO hold down button #1 on your OnlyKey for 10+ seconds and release. The light will turn off and if a PIN has been set re-enter your PIN to enter config mode. You will notice the OnlyKey flashes red in config mode. Click OK to load new firmware."
                            )
                          ) {
                            if (req.responseContent.body) {
                              var contents =
                                req.responseContent.body &&
                                req.responseContent.body.trim();
                              try {
                                console.info("unparsed contents", contents);
                                contents = parseFirmwareData(contents);
                                console.info("parsed contents", contents);
                              } catch (parseError) {
                                throw new Error(
                                  "Could not parse firmware file.\n\n" +
                                    parseError
                                );
                              }
                              console.info(contents);
                              onlyKeyConfigWizard.newFirmware = contents;
                              //First send one message to kick OnlyKey (in config mode) into bootloader
                              console.info("Working... Do not remove OnlyKey");
                              await requestFirmwareLoad();
                              resolve();
                            } else {
                              alert(`Firmware Download Failed`);
                              resolve();
                              return;
                            }
                          }
                        }
                      );
                    }
                  }
                }
              }
            }
          }
        );
      } else if (!fwUpdateSupport) {
        if (
          window.confirm(
            "This application is designed to work with a newer version of OnlyKey firmware. Click OK to go to the firmware download page."
          )
        ) {
          window.location.href =
            "https://docs.crp.to/usersguide.html#loading-onlykey-firmware";
        }
      }
      resolve();
    });
  }
}

/*
 * submitFirmwareData, listenForMessageIncludes and listenForMessageIncludes2
 * lived here: the firmware packet chunker and the "wait for a message that
 * includes X" readers. The lib's requestFirmwareUpdate / sendFirmware /
 * setBackupPassphrase do both, so they are gone rather than left as a second
 * reader (see requestFirmwareLoad and loadFirmware).
 */

function parseFirmwareData(contents = "") {
  // split by newline
  const lines = contents.split("\n");
  lines.shift(); //Remove -----BEGIN SIGNED FIRMWARE-----
  const newContent = [];

  for (let i = 0; i < lines.length - 1; i++) {
    let line = lines[i];
    console.info(`LENGTH: ${line.length}`);
    console.info(`BLOCK: ${line}`);
    newContent.push(line);
  }
  
  return newContent;
}

function wipeRsaKey(e) {
  e && e.preventDefault && e.preventDefault();
  ui.rsaForm.setError("");

  var slot = parseInt(ui.rsaForm.rsaSlot.value || "", 10);
  myOnlyKey.wipePrivateKey(slot, function (err, msg) {
    handleMessage(err, msg);
  });
}

function submitLockout(e) {
  e && e.preventDefault && e.preventDefault();
  var lockout = parseInt(ui.lockoutForm.okLockout.value, 10);
  if (isNaN(lockout)) {
    lockout = 0;
  }

  if (typeof lockout !== "number" || lockout < 0) {
    lockout = 30;
  }

  lockout = Math.min(lockout, 255);

  myOnlyKey.setLockout(lockout, function (err) {
    myOnlyKey.setLastMessage(
      "received",
      "Lockout set to " +
        lockout +
        " minutes" +
        (lockout === 0 ? " (disabled)" : "")
    );
    ui.lockoutForm.reset();
  });
}

function submitstoredchallengeMode(e, storedchallengeMode) {
  e && e.preventDefault && e.preventDefault();
  return myOnlyKey.setstoredchallengeMode(storedchallengeMode);
}

// Field 21 carries an ENUM in the low nibble and FLAGS in the high nibble:
//
//   value & 0x0F   user input mode: 0 = challenge code, 1 = button press,
//                  2 = RESERVED (legacy "disable extension"), 3 = none
//   0x10  bit 4    allow stored-slot sign/decrypt over FIDO2 (PGP in a browser)
//   0x20  bit 5    disable the browser extension entirely
//   0x40, 0x80     reserved
//
// This used to write the whole byte as 0 or 1 from two buttons, so each setting
// silently cleared the others. The form composes the whole byte instead, which
// is why the UI says the options save together.
//
// The kill switch is bit 5 and not bit 1, and "none" is 3 and not 2, because a
// legacy byte of 2 meant "extension disabled": reusing that value for "no
// confirmation required" would flip every key configured that way from the most
// restrictive state to the least. The firmware translates 2 back to its old
// meaning and fails closed on anything it does not recognise. Bits 2 and 3 were removed
// from the firmware and are never written. The firmware accepts this write only
// in config mode.
// These used to be one composed byte written to field 21. They are now four
// independent settings in three EEPROM fields, so this is four writes, not one.
// Field 21 briefly carried policy flags in its high nibble; that collided with
// the firmware's input-mode enum for the same byte, so the policy bits moved to
// their own field. Composing them again here would recreate the collision.
//
// USER_INPUT_NONE (2) is deliberately absent from the 21 and 22 radio groups.
// Production firmware refuses the write outright and fails a stale 2 closed to
// the challenge code, so offering the option would only produce an error the
// user cannot act on. Field 30 does offer it, because there it is honoured -
// for shared secrets and derived decapsulation too (firmware v3.0.5): with
// "No confirmation" the web app and local agents derive and decrypt silently
// whenever the key is unlocked, which is what the tooltip says.
function selectedRadioValue(name, fallback) {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? parseInt(el.value, 10) : fallback;
}

function submitUserInputModes(e) {
  e && e.preventDefault && e.preventDefault();
  myOnlyKey.setderivedchallengeMode(selectedRadioValue("derivedKeyInput", 0));
  myOnlyKey.setstoredchallengeMode(selectedRadioValue("storedKeyInput", 0));
  return myOnlyKey.setwebAgentDeriveMode(selectedRadioValue("webAgentDeriveInput", 1));
}

function submitWebcryptPolicy(e) {
  e && e.preventDefault && e.preventDefault();

  var policy = 0;
  if (document.getElementById("webAllowStoredKey").checked) policy |= 0x01;
  if (document.getElementById("webDisableExtension").checked) policy |= 0x02;

  return myOnlyKey.setwebcryptPolicy(policy);
}

function submithmacchallengeMode(e, hmacchallengeMode) {
  e && e.preventDefault && e.preventDefault();
  return myOnlyKey.sethmacchallengeMode(hmacchallengeMode);
}

function submitmodkeyMode(e, modkeyMode) {
  e && e.preventDefault && e.preventDefault();
  return myOnlyKey.setmodkeyMode(modkeyMode);
}

function submitBackupMode(e, backupKeyMode) {
  e && e.preventDefault && e.preventDefault();
  return myOnlyKey.setbackupKeyMode(backupKeyMode);
}

function submitWipeMode(e, wipeMode) {
  e && e.preventDefault && e.preventDefault();
  return myOnlyKey.setWipeMode(wipeMode);
}

function submitTypeSpeed(e) {
  e && e.preventDefault && e.preventDefault();
  var typeSpeed = parseInt(ui.typeSpeedForm.okTypeSpeed.value, 10);
  console.info('typeSpeed');
  console.info(typeSpeed);
  if (typeof typeSpeed !== "number" || typeSpeed < 1) {
    typeSpeed = 4; //Default type speed
  }

  typeSpeed = Math.min(typeSpeed, 10);
  return myOnlyKey.setTypeSpeed(typeSpeed);
}

function submitLedBrightness(e) {
  e && e.preventDefault && e.preventDefault();
  var ledBrightness = parseInt(ui.ledBrightnessForm.okLedBrightness.value, 10);

  if (typeof ledBrightness !== "number" || ledBrightness < 1) {
    ledBrightness = 8; //Default led brightness
  }

  ledBrightness = Math.min(ledBrightness, 10);
  return myOnlyKey.setLedBrightness(ledBrightness);
}

function submitLockButton(e) {
  e && e.preventDefault && e.preventDefault();
  var lockButton = parseInt(ui.lockButtonForm.okLockButton.value, 10);

  if (typeof lockButton !== "number" || lockButton < 0 || lockButton > 6) {
    return;
  }

  lockButton = Math.min(lockButton, 10);
  return myOnlyKey.setLockButton(lockButton);
}

function submitKBDLayout(e) {
  e && e.preventDefault && e.preventDefault();
  var kbdLayout = parseInt(ui.keyboardLayoutForm.okKeyboardLayout.value, 10);

  if (typeof kbdLayout !== "number" || kbdLayout < 1) {
    kbdLayout = 1;
  }

  return myOnlyKey.setKBDLayout(kbdLayout);
}

function handleVersion(version) {
  myOnlyKey.setVersion(version);
  myOnlyKey.setDeviceType(version);
  setOkVersionStr();
}

function setOkVersionStr() {
  const version = myOnlyKey.getVersion();
  const deviceType = myOnlyKey.getDeviceType();
  let typeStr = "OnlyKey";
  if (deviceType !== DEVICE_TYPES.CLASSIC) {
    typeStr += ` ${deviceType.toUpperCase()}`;
  }

  if (version) {
    document.getElementById("fwVersion").innerText = `${typeStr} ${version}`;
  }
}

window.addEventListener("load", init);

function hexToModhex(inputStr, reverse) {
  // 0123 4567 89ab cdef
  // cbde fghi jkln rtuv
  // Example: hexadecimal number "4711" translates to "fibb"
  var hex = "0123456789abcdef";
  var modhex = "cbdefghijklnrtuv";
  var newStr = "";
  var o = reverse ? modhex : hex;
  var t = reverse ? hex : modhex;
  inputStr.split("").forEach(function (c) {
    var i = o.indexOf(c);
    if (i < 0) {
      throw new Error("Invalid character sent for hexToModhex conversion");
    }
    newStr += t.charAt(i);
  });

  return newStr;
}

function arraytoHexString(byteArray) {
  return Array.from(byteArray, function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('')
}

function hexStringtoByteArray(hexString) {
  var result = [];
  for (var i = 0; i < hexString.length; i += 2) {
    result.push(parseInt(hexString.substr(i, 2), 16));
  }
  return result;
}

function strPad(str, places, char='0') {
  let s = str.toString();
  while (s.length < places) {
    s = `${char}${s}`;
  }
  return s;
}

// http://stackoverflow.com/questions/39460182/decode-base64-to-hexadecimal-string-with-javascript
function base64tohex(base64) {
  var raw = atob(base64);
  var HEX = "";
  var _hex;

  for (i = 0; i < raw.length; i++) {
    _hex = raw.charCodeAt(i).toString(16);
    HEX += _hex.length == 2 ? _hex : "0" + _hex;
  }
  return HEX.toUpperCase();
}

function parseBackupData(contents) {
  var newContents = [];
  // split by newline
  contents.split("\n").forEach(function (line) {
    if (line.indexOf("--") !== 0) {
      newContents.push(base64tohex(line));
    }
  });

  // join back to unified base64 string
  newContents = newContents.join("");
  return newContents;
}

function hexStrToDec(hexStr) {
  return new Number("0x" + hexStr).toString(10);
}

function byteToHex(value) {
  if (value < 16) return "0" + value.toString(16);
  return value.toString(16);
}

//nw.Window.get().on('new-win-policy', function(frame, url, policy) {
//  // do not open the window
//  policy.ignore();
//  // and open it in external browser
//  nw.Shell.openExternal(url);
//});
