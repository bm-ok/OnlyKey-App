const webdriver = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const path = require('path');

// Creates a single webdriver instance that is available for all tests. Also
// includes an `after` hook to properly shut it down.

/*
 * Where NW.js's chromedriver is.
 *
 * Only the SDK flavor of NW.js ships chromedriver, and the App's own `nw`
 * dependency is the normal flavor (it is what the release packages). Since nw
 * 0.9x the package unpacks each flavor to its own folder,
 * node_modules/nw/nwjs[-sdk]-v<version>-<platform>-<arch>/ - there is no
 * node_modules/nw/nwjs any more, which is where this used to look. So:
 *   1. OK_CHROMEDRIVER, a path to an NW.js SDK chromedriver (any checkout's -
 *      e.g. onlykey-testing's node_modules/nw/nwjs-sdk-v0.114.0-<platform>-<arch>/);
 *   2. an SDK folder next to the App's own nw;
 * and otherwise an error that says how to get one. chromedriver launches the nw
 * that sits beside it, so its version is the NW.js the suites run under.
 */
function chromedriverPath() {
    const exe = process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
    if (process.env.OK_CHROMEDRIVER) return process.env.OK_CHROMEDRIVER;
    const nwDir = path.dirname(require.resolve('nw/package.json'));
    const sdk = fs.readdirSync(nwDir)
        .filter((d) => d.startsWith('nwjs-sdk-') && fs.existsSync(path.join(nwDir, d, exe)));
    if (sdk.length) return path.join(nwDir, sdk[0], exe);
    throw new Error(
        `no NW.js SDK chromedriver in ${nwDir} - the App's nw is the normal flavor, ` +
        'which has none. Point OK_CHROMEDRIVER at an nwjs-sdk chromedriver, or ' +
        'install the SDK beside it (npm install --no-save nw@<version>-sdk).');
}

function createDriver() {
    // selenium-webdriver 4 removed chrome.setDefaultService; the service is
    // handed to the builder instead.
    const service = new chrome.ServiceBuilder(chromedriverPath());

    // Point chromedriver to the nwjs app
    const options = new chrome.Options()
        .addArguments('nwapp=' + path.join(path.dirname(__dirname), 'build'));

    return new webdriver.Builder()
        .forBrowser('chrome')
        .setChromeOptions(options)
        .setChromeService(service)
        .build();
}

after(function() {
    const driver = module.exports;
    return driver.quit();
});

module.exports = createDriver();
