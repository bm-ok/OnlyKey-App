const webdriver = require('selenium-webdriver');
const By = webdriver.By;
const until = webdriver.until;
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const expect = chai.expect;

const driver = require('./driver.js');

chai.use(chaiAsPromised);

// A first integration test. Mostly a proof of concept to show that Selenium,
// Mocha, and nwjs can work together.

describe('OnlyKey Configuration', function() {

    // Every step is awaited: selenium-webdriver 4 dropped the control flow that
    // once ran un-awaited calls in order. app.html's title is "OnlyKey App"; the
    // old 'OnlyKey Configuration Wizard' wait was never awaited, so it never
    // checked anything.
    it('should start disconnected', async function() {
        await driver.navigate().refresh();
        await driver.wait(until.titleIs('OnlyKey App'), 15000);

        const disconnected = await driver.findElement(By.id('disconnected-dialog'));
        return expect(disconnected.getAttribute('open')).to.eventually.equal('true');
    });

    it('should not show "working..." dialog', async function() {
        await driver.wait(until.titleIs('OnlyKey App'), 15000);

        const working = await driver.findElement(By.id('working-dialog'));
        return expect(working.getAttribute('open')).to.eventually.equal(null);
    });
});
