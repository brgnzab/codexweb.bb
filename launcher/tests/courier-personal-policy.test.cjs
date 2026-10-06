const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { readCourierFailure } = require("../electron/courier-diagnostic.cjs");
const { verifyPrivatePath } = require("../electron/private-path.cjs");
const helper = path.resolve(__dirname, "../../scripts/cwc-desktop-bridge.cjs");
const worker = "10000000-0000-0000-0000-000000000001";
const destination = "20000000-0000-0000-0000-000000000002";

test("standalone Personal courier handles inherited Windows paths, silent receipts and app-owned failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwc-personal-courier-"));
  const dir = path.join(root, "council");
  fs.mkdirSync(dir);
  let turn = { id: "delivery", peer: 0, prompt: "opaque participant message", state: "claimed", lease: "lease", worker, claimedAt: Date.now() };
  let state = "running";
  const calls = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${"x".repeat(64)}`);
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); const op = req.url.split("/").at(-1); calls.push(op);
    let result;
    if (op === "list") result = { relays: [{ id: "relay", state, peers: [{ kind: "codex", conversation: destination }], turns: [turn] }] };
    else if (op === "submitting") { turn.state = "submitted"; result = { accepted: true }; }
    else if (op === "complete") { turn.state = "completed"; state = "completed"; result = { accepted: true }; }
    else if (op === "fail") { state = turn.state === "submitted" ? "uncertain" : "failed"; result = { accepted: true }; }
    else throw new Error(`Unexpected owner operation ${op}`);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  fs.writeFileSync(path.join(dir, "owner-control.json"), JSON.stringify({ version: 1, endpoint: `http://127.0.0.1:${server.address().port}/api/owner`, token: "x".repeat(64) }));
  const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: root, CODEX_THREAD_ID: worker };
  delete env.CODEXWEB_COUNCIL_PRODUCT; // Reproduce the actual standalone process, not launcher's env.
  let sequence = 0;
  const cli = async (request, filename) => {
    filename ??= path.join(dir, `request-${++sequence}.json`);
    fs.writeFileSync(filename, JSON.stringify(request));
    const child = spawn(process.execPath, [helper, filename], { env, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const [code] = await once(child, "exit"); return { code, stdout, stderr };
  };
  const snapshot = (status = "completed") => ({ schemaVersion: 1, thread: { id: destination, kind: "codex", status: { type: status === "completed" ? "idle" : "active" } },
    turns: [{ id: "turn", status, items: [{ type: "userMessage", content: [{ type: "text", text: turn.prompt }] },
      ...(status === "completed" ? [{ type: "agentMessage", id: "answer", text: "message\nCWC_STATE: CONTINUE", phase: "final_answer" }] : [])] }] });
  try {
    const claimed = await cli({ operation: "claim" });
    assert.equal(claimed.code, 0); assert.equal(claimed.stderr, "");
    assert.deepEqual(JSON.parse(claimed.stdout), { threadId: destination, prompt: turn.prompt });
    const prepared = await cli({ operation: "prepare", snapshot: { ...snapshot(), turns: [] } });
    assert.equal(prepared.code, 0); assert.equal(turn.state, "submitted");
    assert.deepEqual(JSON.parse((await cli({ operation: "claim" })).stdout), { threadId: destination });
    assert.deepEqual(await cli({ operation: "sent", result: { content: [{ type: "text", text: "queued" }] } }), { code: 0, stdout: "", stderr: "" });
    const pending = await cli({ operation: "observe", snapshot: snapshot("inProgress") });
    assert.deepEqual(JSON.parse(pending.stdout), { threadId: destination });
    assert.deepEqual(await cli({ operation: "observe", snapshot: snapshot() }), { code: 0, stdout: "", stderr: "" });
    assert.equal(state, "completed");
    // A new assignment with the same controller cannot inherit completed project routing.
    turn = { ...turn, id: "new-delivery", prompt: "new project", state: "claimed" }; state = "running";
    assert.equal(JSON.parse((await cli({ operation: "claim" })).stdout).prompt, "new project");
    const badRead = { ...snapshot(), truncated: true };
    assert.deepEqual(await cli({ operation: "prepare", snapshot: badRead }), { code: 1, stdout: "", stderr: "" });
    assert.equal(state, "failed");
    assert.match(readCourierFailure(root, worker), /courier failed/i);
    assert.equal(readCourierFailure(root, destination), undefined);
    assert.equal(readCourierFailure(root, worker, Date.now() + 1000), undefined);
    // A later successful claim resolves the optional bridge warning durably, across restarts.
    turn = { ...turn, state: "claimed" }; state = "running";
    assert.equal((await cli({ operation: "claim" })).code, 0);
    assert.equal(readCourierFailure(root, worker, 0), undefined);
    assert.equal(Number.isFinite(JSON.parse(fs.readFileSync(path.join(dir, "courier-error.json"), "utf8")).resolvedAt), true);
    // After submission an unreadable receipt remains uncertain; no second submit occurs.
    turn = { ...turn, state: "submitted" }; state = "running";
    assert.equal((await cli({ operation: "observe", snapshot: badRead })).code, 1);
    assert.equal(state, "uncertain");
    const before = calls.length;
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
    try { assert.equal((await cli({ operation: "claim" }, outside)).code, 1); assert.equal(calls.length, before); }
    finally { fs.rmSync(outside, { force: true }); }
    const redirectTarget = path.join(root, "redirect-target");
    const redirect = path.join(root, "redirect");
    fs.mkdirSync(redirectTarget);
    fs.symlinkSync(redirectTarget, redirect, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.equal((await cli({ operation: "claim" }, path.join(redirect, "request.json"))).code, 1);
      assert.equal(calls.length, before);
      assert.throws(() => verifyPrivatePath(path.join(redirect, "missing.json"), { personalRoot: root }), /reparse/);
    } finally { fs.unlinkSync(redirect); }
    const diagnostic = fs.readFileSync(path.join(dir, "courier-error.json"), "utf8");
    assert.equal(diagnostic.includes("opaque participant message"), false);
    assert.equal(diagnostic.includes("x".repeat(64)), false);
    assert.throws(() => verifyPrivatePath(path.dirname(root), { personalRoot: root }), /outside/);
    if (process.platform === "win32") assert.equal(verifyPrivatePath(path.join(dir, "owner-control.json").toLowerCase(), { personalRoot: root.toUpperCase() }).toLowerCase(), path.join(dir, "owner-control.json").toLowerCase());
  } finally { server.close(); await once(server, "close"); fs.rmSync(root, { recursive: true, force: true }); }
});
