const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const main = readFileSync(join(root, "src", "main.tsx"), "utf8");
const app = readFileSync(join(root, "src", "CouncilApp.tsx"), "utf8");
const types = readFileSync(join(root, "src", "types.ts"), "utf8");
const preload = readFileSync(join(root, "electron", "preload.cjs"), "utf8");
const shellCss = readFileSync(join(root, "src", "council-shell.css"), "utf8");

test("Mission Control mounts only the current Council App shell", () => {
  assert.match(main, /import \{ App \} from "\.\/App"/);
  assert.match(main, /<App\s*\/>/);
  assert.doesNotMatch(main, /CouncilUpdatePrompt|CouncilDock|CouncilAgentsPanel|CouncilSetupPanel|CouncilSupervisorPanel|council-update\.css/);
  assert.match(main, /import "\.\/styles\.css"/);
  assert.match(main, /import "\.\/council-4-shell-foundation\.css"/);
  assert.match(main, /import "\.\/council-4-workspaces\.css"/);
  assert.match(main, /import "\.\/council-4-detail\.css"/);
  assert.match(main, /import "\.\/council-4-responsive\.css"/);
});

test("current Council renderer consumes the main-process shared projection", () => {
  assert.match(app, /onCouncilRuntime/);
  assert.match(app, /projection\.syncState/);
  assert.match(preload, /onCouncilRuntime/);
  assert.match(types, /CouncilRuntimeViewState/);
  assert.match(types, /councilRuntime/);
  assert.match(types, /onCouncilRuntime/);
  assert.doesNotMatch(app, /http:\/\/127\.0\.0\.1:17842\/api\/state/);
});

test("current managed-agent tabs use controller-provided browser tabs without private conversation state", () => {
  assert.match(app, /tabByAgent/);
  assert.match(app, /selectBrowserTab\(tab\.id\)/);
  assert.doesNotMatch(app, /conversationUrl/);
  assert.doesNotMatch(app, /checkpoint\b/);
});

test("current ChatGPT workspace explicitly hides and restores the external browser surface", () => {
  assert.match(app, /setBrowserSurfaceActive\(visible\)/);
  assert.match(app, /hideBrowser\(\)/);
  assert.match(app, /showBrowser\(\)/);
});

test("current Mission Control shell uses the active visual token system", () => {
  assert.match(shellCss, /var\(--c-bg\)/);
  assert.match(shellCss, /var\(--c-line\)/);
  assert.match(shellCss, /var\(--c-text\)/);
});
