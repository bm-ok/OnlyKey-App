# OnlyKey App on node-onlykey-lib

Branch `use-node-onlykey-lib`. The UI is unchanged: `app.html`, `OnlyKeyWizard.js`, the form handlers and every last-message string the UI branches on stay as they were. The device half of `OnlyKeyComm.js` is now a facade over [node-onlykey-lib](https://github.com/bmatusiak/node-onlykey-lib), pinned in `package.json` at `d1b62ea`. The lib is the protocol library the other GUIs share. No frame is built by hand in the App any more: every device operation is a lib method.

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
| `sendPin_DUO(pins, set, cb)` | `device.duoPin(pins, {set})`, which skips a status broadcast that predates the PIN. On a locked key the answer is also passed to `handleMessage` |
| `setSlot(slot, field, value, cb)` | `device.setSlot(slot, {[field]: value})`, one field per call, and `cb` runs on the device's answer. Slot 0 settings go to `setPreference`. A field the lib has no name for is refused; no field the App writes is one |
| `wipeSlot(slot, field, cb)` | `device.wipeSlot(slot, field)` |
| `setYubiAuth(pub, priv, secret, cb)` | `device.setYubiAuth({...})` |
| `wipeYubiAuth(cb)` | `device.wipeYubiAuth()`. Silent on success: the list says "Yubico OTP wipe sent (OnlyKey does not confirm this)"; a refusal goes to `cb` |
| `setPrivateKey` / `submitRsaKey` / `confirmRsaKeySelect` | `device.loadKey(slot, {type, key})`. The lib sends 57-byte chunks for RSA and waits for the answer |
| `wipePrivateKey(slot, cb)` | `device.wipeKey(slot, {keepLabel: true})` |
| `setBackupPassphrase(p, cb)` | `device.setBackupPassphrase(p)` (SHA-256 into slot 131, type 161) |
| `setRSABackupKey` | Unchanged: the App parses the key with openpgp, then the key selection dialog, then `loadKey` |
| `submitRestore` / `submitRestoreForm` | `device.restore(text, {unverifiable: true})`. With no file (the wizard's reboot request) `device.restartByRestore()`: the list says "OnlyKey restart requested (OnlyKey does not confirm this)"; a refusal goes to `cb` |
| `submitFirmware` / `submitFirmwareForm` / `checkForNewFW` request | `requestFirmwareLoad()` → `device.requestFirmwareUpdate()` |
| `loadFirmware` / `initBootloaderMode` | `device.sendFirmware(text, {onProgress})` |
| `setLockout`, `setWipeMode`, `setbackupKeyMode`, `setderivedchallengeMode`, `setstoredchallengeMode`, `setwebAgentDeriveMode`, `setwebcryptPolicy`, `sethmacchallengeMode`, `setmodkeyMode`, `setTypeSpeed`, `setLedBrightness`, `setLockButton`, `setKBDLayout` | `device.setPreference(name, value)` |
| `setSlotTypeSpeed(slot, n)` | `device.setSlot(slot, {typeSpeed})` |
| `setSecProfileMode(mode, cb)` | `device.setPreference('secProfileMode', mode)`. Silent on success; `cb(null, "OK")` as before, or the refusal |
| `listen(cb)`, `listenforvalue()` | Kept for compatibility: they take the next message from the one reader. Nothing in the App calls them |
| `pollForInput`, `handleGetLabels`, `submitFirmwareData`, `listenForMessageIncludes(2)`, `OnlyKey.prototype.firmware` | **Removed.** The lib does this work, and none of them can run as a second reader |
| `sendMessage`, `OnlyKey.prototype.restore`, `submitRestoreData` | **Removed.** They built raw frames for the operations the lib lacked. The lib has all of them now |
| `handleMessage` | Unchanged apart from its three `pollForInput()` re-arm calls, which were removed because the reader never stops |

### Classic PIN mapping (risk 2)

The wizard decides when each message goes out, because the person presses the key's buttons between messages.

| Wizard | Count | `pinStep` | Device says |
|---|---|---|---|
| Step2 enterFn: `flushMessage(sendSetPin)` | 0→1 | `armed` | "OnlyKey is ready, enter your PIN" |
| Step2 exitFn: `sendSetPin` | 1→2 | `stored` | "Successful PIN entry" |
| Step3 enterFn: `sendSetPin` | 2→3 | `confirming` | "...ready, re-enter your PIN to confirm" |
| Step3 exitFn: `sendSetPin` | 3→0 | `matched`, then `committed` | "Successfully set PIN" |

The same table applies to OKSETPIN2 (Steps 4/5) and OKSETSDPIN (Steps 6/7). A refusal ("PIN is not between 7 - 10 digits", or a mismatch) sets the count to 0, as the firmware does, and calls back `(message, msgId)`. `goBackOnError` switches on that value. Any other device refusal ends the step immediately, because the lib's `pinStep` ends on any of them, and leaves the count unchanged. `committed` sends nothing and returns at once: the App's pipe carries no console, and the lib waits for one only when it has spoken.

## Lib gaps

The port's first cut found seven things the App needed and the lib did not provide. node-onlykey-lib `d1b62ea` (CHANGELOG 0.3.0) closed the first six, each read against firmware release 3.1.0, and the App now uses the lib for all of them. The App's raw frames (`sendMessage`) and its PIN "Error" watcher are gone.

### Closed: now the library's

| Gap | Was in the App | Now |
|---|---|---|
| 1. No global Yubico wipe (the firmware wipes slot 0 field 10 without a reply) | Raw frame, callback once the frame was out | `device.wipeYubiAuth()` |
| 2. `secProfileMode` stored silently on first use, refused later with a sentence that has no "Error"; the lib spent three 10 s timeouts on it mid PIN bracket | Raw frame | `device.setPreference('secProfileMode', v)`: sent once, silence taken as set, the sentence thrown as a refusal |
| 3. `pinStep` ended only on the two PIN refusals | The facade raced its own "Error" watcher (`pinErrorWatch`) | `pinStep` ends on any device refusal, including the ones without "Error" |
| 4. No restart-by-restore | Raw frame: the wizard's nine zeros, whose length byte was 0 only by accident ("4.8" → NaN → 0) | `device.restartByRestore()`, which builds the zero on purpose |
| 5. `pinStep('committed')` waited the full timeout on a release build | The facade stopped at `matched` | `committed` runs after `matched`; the lib waits for a console only when one has spoken |
| 6. `duoPin` took the first report, which on a locked DUO can be a broadcast from before the PIN | The App had the same race | `duoPin` skips a locked broadcast inside 500 ms of the write |

Three of these (1, 2, 4) succeed in silence. The lib sends each **once**, never retries it, listens briefly for a refusal, and returns `confirmed: false`. Silence is also what a frame the key never acted on looks like, so the App never says they are done: the list says "Yubico OTP wipe sent (OnlyKey does not confirm this)" and "OnlyKey restart requested (OnlyKey does not confirm this)", and says nothing for `secProfileMode`, whose PIN step speaks next. A refusal reaches the callback in the device's words.

### Still open

7. **Backup passphrase bytes are not verified.** The lib hashes the Latin-1 bytes of the passphrase. The App used `openpgp.crypto.hash.digest(8, string)` from its vendored openpgp. For ASCII the result is the same (checked against Node's SHA-256 in the tests). For non-ASCII passphrases it has not been checked.

And what the closed gaps cannot do, because the firmware gives nothing more to go on:

- **A silent success cannot be told from a dropped frame.** A non-STD build or an unencrypted profile drops `secProfileMode` and the empty restore in silence too.
- **`restartByRestore` finishes a part-sent restore instead of restarting.** RESTORE's `offset` is static, so if a restore stopped midway this boot, the empty last packet completes it. The lib refuses a bad digest before any byte goes out, so only a transport failure mid-send leaves the key in that state. A restart clears it.
- **`restartByRestore` restarts only where a restore is allowed**: config mode or first use. Elsewhere the key says "Error not in config mode", and the wizard stays on the restore step (`goBackOnError` has no case for OKRESTORE), which is where the old code stopped when a send failed.
- **`duoPin` tells the stale broadcast from the answer by timing only.** The 500 ms window is read from the firmware's 1 s broadcast period, not measured on a DUO.

## Behaviour that differs, on purpose

- **Slot writes wait for the device's answer.** A device "Error" now reaches the wizard as an error instead of being skipped. On an error the wizard leaves the slot dialog's Save button disabled; that is existing wizard behaviour.
- **Restore refuses a backup file whose digest is present and wrong.** The App used to send it anyway. A file with no digest (firmware before v2.1.2) is still sent.
- **The Firmware panel shows "Firmware file sent to OnlyKey" once the key accepts the request.** This callback never ran before, because it was passed to a function that takes no callback.
- **A DUO no longer receives an empty OKSETPIN when the wizard flushes.** The flush toggle was shared with the classic bracket.
- **Silence is no longer waited on forever.** A PIN step times out after 10 s, a setting after 3 tries of 10 s, and a slot field after 3 tries of 3 s. The lib retries an unanswered write, except the three silent operations above, which are sent once.
- **Settings refused by the lib appear on the message list.** Examples are an out-of-range value, or webAgentDeriveMode or webcryptPolicy on firmware older than 3.0.5.
- **`onDeviceRemoved` always updates the UI.** Before, a disconnect error made it return early.

## NW.js 0.114 (was 0.71.1)

The lib cannot load on NW 0.71.1, and on NW 0.114 the old launch path cannot finish loading. Both were measured on Windows and Linux with a CDP probe of the page (2026-09-29):

| NW | launch | page | lib |
|---|---|---|---|
| 0.71.1 (Node 19.3) | Chrome-app background (`main: app.js`) | completes | **fails**: `require()` of the lib's vendored ES-module @noble; Node 19 has no require(esm). `okLibPipe` stays null and the App never reaches the key |
| 0.114 (Node 26) | Chrome-app background | **stays `loading`**, even for an empty page, and even with `persistent: true` | loads |
| 0.114 | `main: app.html` | completes | loads, App reads the key |

The master branch (6.0.0 before the port) hangs the same way on 0.114, so the hang is NW's, not the port's. So:

- `package.json`: `nw` is pinned to `0.114.0`, `main` is `app.html`, and the `window` block is 1024x768, the size `app.js` used to open. `allowScripts` approves nw's postinstall, which downloads the runtime; npm 11 skips it otherwise.
- `app/app.js` no longer runs under NW. It stays as the Chrome build's background page. Its first-run auto-launch default moved to `app/scripts/tray.js`.
- The nw package now unpacks to `node_modules/nw/nwjs-v<version>-<platform>-<arch>/`, and its `findpath()` is async. `tasks/utils.js` `nwRuntimeDir()` asks the package, and `start.js` plus the three release tasks use it.
- The normal flavor has no devtools or remote debugging. To probe a page, run the same build with `nw@0.114.0-sdk`.

## Not verified: these need a device

`npm run test:lib` passes (52 tests). It covers the pipe, the lib stack against a scripted key, and the real page scripts in a vm with a fake DOM. The App also starts on NW 0.114 and reads the emulated key (Windows, okvhid). The following have **not** been run:

- **The selenium suites.** `test/driver.js` looks for chromedriver at `node_modules/nw/nwjs/`. That path is gone in 0.114, and chromedriver ships only with the `-sdk` flavor.
- **Any real key.** Nothing has been tested against hardware: timings, locked broadcasts, the VM case the double OKSETTIME was for, the DUO config-mode path (`INITIALIZED-D` → `setTime` loop, now coalesced), and how the bootloader answers the lib's OKCONNECT (time plus a 32-byte transit key; the old OKSETTIME carried only the time).
- **Firmware update has only been run against the scripted mock. Do not test it on a key you cannot re-image.**
- **`test/configure-slot-test.js` (selenium) will need rework.** It injects replies before the requests they answer, relying on Chrome's queue to feed whichever one-shot reader asked next. It also indexes `_sent` on the assumption that slot writes are not acknowledged. The mock hooks themselves still work.
- **The Chrome-app build (`--env=chrome`)** has no `require` and cannot load the lib.

## Risks

1. **UI wording (risk 1).** The UI branches on message text. The facade records every report the way `pollForInput` did, and the tests check the strings. Any flow not in the tests keeps the old wording but has not been exercised.
2. **Reply ownership.** A report that arrives while a lib operation is in flight is not given to `handleMessage`. That matches the old callback flows. However, an unrelated message that arrives during an operation (for example a status change) is only recorded, not acted on.
3. **Timing.** Pacing is kept, but the lib adds its own waits (settle times, retries). None of these have been observed on hardware from this App.
