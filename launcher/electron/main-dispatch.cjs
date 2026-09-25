if (process.argv.includes("--launcher-smoke-test")) {
  require("./smoke-main.cjs");
} else {
  require("./main-hardened.cjs");
}
