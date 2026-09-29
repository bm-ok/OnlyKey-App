"use strict";

const argv = require("yargs").argv;
const os = require("os");

module.exports.os = function () {
  switch (os.platform()) {
    case "darwin":
      return "osx";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
  }
  return "unsupported";
};

module.exports.replace = function (str, patterns) {
  Object.keys(patterns).forEach(function (pattern) {
    var matcher = new RegExp("{{" + pattern + "}}", "g");
    str = str.replace(matcher, patterns[pattern]);
  });
  return str;
};

module.exports.getEnvName = getEnvName;

module.exports.getNodeModulesDir = function (params = {}) {
  return (params.env || getEnvName()) === "production"
    ? "release_node_modules/node_modules"
    : "node_modules";
};

// The NW.js runtime directory (nw.exe / nw / nwjs.app and everything beside it).
// Newer nw packages unpack to node_modules/nw/nwjs[-sdk]-v<version>-<platform>-<arch>/
// (0.71 used node_modules/nw/nwjs), and their findpath() is async. Ask the package
// rather than hard-coding the folder, so the next NW bump needs no task change.
module.exports.nwRuntimeDir = async function (nodeModulesDir = "node_modules") {
  const nw = require(require("path").resolve(nodeModulesDir, "nw"));
  return nw.findpath("all");
};

function getEnvName() {
  return argv.env || "development";
}
