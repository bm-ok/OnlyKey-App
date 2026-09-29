# OnlyKey App on node-onlykey-lib

Branch `use-node-onlykey-lib`. The UI is unchanged: `app.html`, `OnlyKeyWizard.js`, the form handlers and every last-message string the UI branches on stay as they were. The device half of `OnlyKeyComm.js` is now a facade over [node-onlykey-lib](https://github.com/bmatusiak/node-onlykey-lib), pinned in `package.json` at `497af6e`. The lib is the protocol library the other GUIs share.

## What changed

| File | Change |
|---|---|
| `app/scripts/onlyKey/libPipe.js` | **New.** A byte pipe over chrome.hid in the lib's pipe contract, the lib stack composed over it, and the App-to-lib mapping tables. |
| `app/scripts/onlyKey/OnlyKeyComm.js` | The device half is now a facade: `OnlyKey` prototype, the reader, connect and disconnect, and the key, restore and firmware handlers. The UI half is unchanged. |
| `test/lib/*` | **New.** Mocha suites that need no device, NW.js or selenium. Run them with `npm run test:lib`. |
| `package.json` | Adds `node-onlykey-lib` (git pin) and the `test:lib` script. |

## The seam

```
OnlyKeyWizard.js / form handlers        (unchanged)
        |  same OnlyKey methods and callbacks
OnlyKeyComm.js facade  --onVendorReport-->  handleMessage / last-message list
        |  libOp(): device.connect / readLabels / pinStep / setSlot / ...
node-onlykey-lib: host, transport/usb, session, device, okcrypto   (Rectify)
        |  pipe contract: start, stop, isRunning, write(iface, bytes), on('stream')
libPipe.js createChromeHidPipe  ->  chromeHid wrapper  ->  chrome.hid
```

- **One reader.** `pollForInput` used a one-shot `chrome.hid.receive` that each handler re-armed. It has been removed, and every call site was changed in the same commit. The pipe runs a receive loop that re-arms itself. Every report reaches `onVendorReport`, which does what `pollForInput` did to each message: it records the message, learns the version and tracks lock and config mode. Unsolicited messages then go to `handleMessage`. While a lib operation is in flight (`libBusy`), the replies belong to that operation, the same way a reply the old code read into a callback never reached `handleMessage`.
- **Hot-plug stays in the App.** `onDeviceAdded` still chooses the collection (usage page 0xFFAB with serial 1000000000, or the pre-beta-8 fallback). `connectDevice` opens the lib stack on that collection. `onDeviceRemoved` tears it down.
- **NW.js contexts.** A module loaded with `require()` runs in the Node context, where `chrome` does not exist and `instanceof Uint8Array` is false for page arrays. For that reason the pipe calls the page's `chromeHid` wrapper, which also keeps the selenium mock hooks. The page builds the `ArrayBuffer` for `send`, and received data is duck-typed.
- **Pacing.** The App waited 100 ms after every send except OKFWUPDATE, and the pipe keeps that wait.

## Method-by-method mapping

| OnlyKeyComm (unchanged name and signature) | Now |
|---|---|
| `setTime(cb)` | `device.connect()` (OKCONNECT = OKSETTIME, 0xE4). Retried once if there is no answer, which replaces the old double send. Concurrent calls are coalesced. `cb(null, status)` |
| `getLabels()` | `device.setDeviceType(classic/duo)` + `device.readLabels()`, then `initSlotConfigForm()` |
| `sendSetPin` / `sendSetPin2` / `sendSetSDPin` → `sendPinMessage` | `device.pinStep(label, {kind})`. The label comes from a per-kind count that mirrors the firmware's `pin_set`. See the PIN mapping below |
| `flushMessage(cb)` | The next `pinStep` of the open kind. The firmware refuses it and goes back to 0. The list shows "Canceled" |
| `sendPin_DUO(pins, set, cb)` | `device.duoPin(pins, {set})`. On a locked key the answer is also passed to `handleMessage` |
| `setSlot(slot, field, value, cb)` | `device.setSlot(slot, {[field]: value})`, one field per call, and `cb` runs on the device's answer. Slot 0 settings go to `setPreference` |
| `wipeSlot(slot, field, cb)` | `device.wipeSlot(slot, field)` |
| `setYubiAuth(pub, priv, secret, cb)` | `device.setYubiAuth({...})` |
| `wipeYubiAuth(cb)` | **Raw frame** (lib gap 1) |
| `setPrivateKey` / `submitRsaKey` / `confirmRsaKeySelect` | `device.loadKey(slot, {type, key})`. The lib sends 57-byte chunks for RSA and waits for the answer |
| `wipePrivateKey(slot, cb)` | `device.wipeKey(slot, {keepLabel: true})` |
| `setBackupPassphrase(p, cb)` | `device.setBackupPassphrase(p)` (SHA-256 into slot 131, type 161) |
| `setRSABackupKey` | Unchanged: the App parses the key with openpgp, then the key selection dialog, then `loadKey` |
| `submitRestore` / `submitRestoreForm` | `device.restore(text, {unverifiable: true})`. With no file the wizard sends its reboot request as a **raw frame** (lib gap 4) |
| `submitFirmware` / `submitFirmwareForm` / `checkForNewFW` request | `requestFirmwareLoad()` → `device.requestFirmwareUpdate()` |
| `loadFirmware` / `initBootloaderMode` | `device.sendFirmware(text, {onProgress})` |
| `setLockout`, `setWipeMode`, `setbackupKeyMode`, `setderivedchallengeMode`, `setstoredchallengeMode`, `setwebAgentDeriveMode`, `setwebcryptPolicy`, `sethmacchallengeMode`, `setmodkeyMode`, `setTypeSpeed`, `setLedBrightness`, `setLockButton`, `setKBDLayout` | `device.setPreference(name, value)` |
| `setSlotTypeSpeed(slot, n)` | `device.setSlot(slot, {typeSpeed})` |
| `setSecProfileMode(mode, cb)` | **Raw frame** (lib gap 2) |
| `sendMessage(options, cb)` | Builds the same 64-byte frame and writes it through the lib's transport. Only the gap operations use it now |
| `listen(cb)`, `listenforvalue()` | Kept for compatibility: they take the next message from the one reader. Nothing in the App calls them |
| `pollForInput`, `handleGetLabels`, `submitFirmwareData`, `listenForMessageIncludes(2)`, `OnlyKey.prototype.firmware` | **Removed.** The lib does this work, and none of them can run as a second reader |
| `handleMessage` | Unchanged apart from its three `pollForInput()` re-arm calls, which were removed because the reader never stops |

### Classic PIN mapping (risk 2)

The wizard decides when each message goes out, because the person presses the key's buttons between messages.

| Wizard | Count | `pinStep` | Device says |
|---|---|---|---|
| Step2 enterFn: `flushMessage(sendSetPin)` | 0→1 | `armed` | "OnlyKey is ready, enter your PIN" |
| Step2 exitFn: `sendSetPin` | 1→2 | `stored` | "Successful PIN entry" |
| Step3 enterFn: `sendSetPin` | 2→3 | `confirming` | "...ready, re-enter your PIN to confirm" |
| Step3 exitFn: `sendSetPin` | 3→0 | `matched` | "Successfully set PIN" |

The same table applies to OKSETPIN2 (Steps 4/5) and OKSETSDPIN (Steps 6/7). A refusal ("PIN is not between 7 - 10 digits", or a mismatch) sets the count to 0, as the firmware does, and calls back `(message, msgId)`. `goBackOnError` switches on that value. Any other "Error ..." ends the step immediately and leaves the count unchanged. The lib's `committed` step is not run (see note 5).

## Lib gaps

These are things the App needs and the lib does not provide. Each one is handled in the App as described, and each is marked in the source.

1. **No global Yubico wipe.** The firmware wipes slot 0 field 10 silently: `okcore.cpp` `wipe_slot` has no hidprint for that case. `device.wipeSlot` waits for an acknowledgement, so it would time out. The App sends its own raw frame and calls back once the frame is out. The old code waited for "wiped AES Key", which never arrives.
2. **`setPreference('secProfileMode')` cannot succeed on first use.** The firmware accepts the value silently (the hidprint in `set_slot` case 23 is commented out), and its refusal ("Second Profile Mode may only be changed on first use") does not begin with "Error". The lib would retry three times at 10 s each, mid PIN bracket. The App sends its raw frame.
3. **`pinStep` only knows the two PIN refusals.** Any other device "Error ..." (not in config mode, device locked) does not end the step, so it waits out `timeoutMs` (10 s). The facade races its own watcher for "Error" replies.
4. **No restart-by-restore.** The wizard's Exit on the restore step sends a no-file restore: one OKRESTORE frame with a zero header and zero data, which makes the key restart. `device.restore` refuses empty or odd-length input. `device.restart()` uses the debug console, which release builds do not have. The App sends its raw frame.
5. **`pinStep('committed')` has no wire prompt.** On a release build it waits the full timeout for a console line. The facade stops at `matched`.
6. **`duoPin` takes the first report.** On a locked DUO that can be a status broadcast instead of the answer. The App had the same race.
7. **Backup passphrase bytes are not verified.** The lib hashes the Latin-1 bytes of the passphrase. The App used `openpgp.crypto.hash.digest(8, string)` from its vendored openpgp. For ASCII the result is the same (checked against Node's SHA-256 in the tests). For non-ASCII passphrases it has not been checked.

## Behaviour that differs, on purpose

- **Slot writes wait for the device's answer.** A device "Error" now reaches the wizard as an error instead of being skipped. On an error the wizard leaves the slot dialog's Save button disabled; that is existing wizard behaviour.
- **Restore refuses a backup file whose digest is present and wrong.** The App used to send it anyway. A file with no digest (firmware before v2.1.2) is still sent.
- **The Firmware panel shows "Firmware file sent to OnlyKey" once the key accepts the request.** This callback never ran before, because it was passed to a function that takes no callback.
- **A DUO no longer receives an empty OKSETPIN when the wizard flushes.** The flush toggle was shared with the classic bracket.
- **Silence is no longer waited on forever.** A PIN step times out after 10 s, a setting after 3 tries of 10 s, and a slot field after 3 tries of 3 s. The lib retries an unanswered write.
- **Settings refused by the lib appear on the message list.** Examples are an out-of-range value, or webAgentDeriveMode or webcryptPolicy on firmware older than 3.0.5.
- **`onDeviceRemoved` always updates the UI.** Before, a disconnect error made it return early.

## Not verified: these need a device, and NW.js

`npm run test:lib` passes (48 tests). It covers the pipe, the lib stack against a scripted key, and the real page scripts in a vm with a fake DOM. The following have **not** been run:

- **The App launching in NW.js 0.71.** `npm install` did not run the `nw` postinstall (`npm warn allow-scripts`: nw, es5-ext), so there is no NW binary or chromedriver. This means the selenium suites were not run either. Two assumptions are untested: that relative `require("./scripts/onlyKey/libPipe.js")` resolves in the page (it matches `./scripts/userPreferences.js`), and that chrome.hid accepts the page-made `ArrayBuffer`.
- **Any real key.** Nothing has been tested against hardware: timings, locked broadcasts, the VM case the double OKSETTIME was for, the DUO config-mode path (`INITIALIZED-D` → `setTime` loop, now coalesced), and how the bootloader answers the lib's OKCONNECT (time plus a 32-byte transit key; the old OKSETTIME carried only the time).
- **Firmware update has only been run against the scripted mock. Do not test it on a key you cannot re-image.**
- **`test/configure-slot-test.js` (selenium) will need rework.** It injects replies before the requests they answer, relying on Chrome's queue to feed whichever one-shot reader asked next. It also indexes `_sent` on the assumption that slot writes are not acknowledged. The mock hooks themselves still work.
- **The Chrome-app build (`--env=chrome`)** has no `require` and cannot load the lib.

## Risks

1. **UI wording (risk 1).** The UI branches on message text. The facade records every report the way `pollForInput` did, and the tests check the strings. Any flow not in the tests keeps the old wording but has not been exercised.
2. **Reply ownership.** A report that arrives while a lib operation is in flight is not given to `handleMessage`. That matches the old callback flows. However, an unrelated message that arrives during an operation (for example a status change) is only recorded, not acted on.
3. **Timing.** Pacing is kept, but the lib adds its own waits (settle times, retries). None of these have been observed on hardware from this App.
