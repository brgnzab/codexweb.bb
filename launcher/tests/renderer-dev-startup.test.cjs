const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('actual Vite renderer startup uses an external React preamble under restrictive header CSP', async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const root = path.resolve(__dirname, '..');
  const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore', windowsHide: true });
  try {
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    while (true) {
      try { if ((await fetch(origin)).ok) break; } catch {}
      if (server.exitCode !== null || Date.now() >= deadline) throw new Error('Vite startup failed');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /object-src 'none'; base-uri 'none'/);
    assert.match(policy, new RegExp(`connect-src 'self' http://127\\.0\\.0\\.1:${port} ws://127\\.0\\.0\\.1:${port};`));
    assert.doesNotMatch(policy, /127\.0\.0\.1:\*|unsafe-eval/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length >= 3);
    for (const script of scripts) { assert.match(script[1], /\bsrc=/); assert.equal(script[2].trim(), ''); }
    assert.match(scripts[0][1], /src="\/@cwc\/react-refresh-preamble"/);
    const preamble = await fetch(`${origin}/@cwc/react-refresh-preamble`);
    assert.equal(preamble.status, 200);
    assert.match(preamble.headers.get('content-type'), /javascript/);
    assert.equal(preamble.headers.get('content-security-policy'), policy);
    const source = await preamble.text();
    assert.match(source, /injectIntoGlobalHook\(window\)/);
    assert.match(source, /window\.\$RefreshReg\$/);
    assert.doesNotMatch(source, /__BASE__/);
  } finally {
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  }
});
