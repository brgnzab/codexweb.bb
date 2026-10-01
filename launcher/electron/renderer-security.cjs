function trustedLauncherSender(event, window, navigationAllowed) {
  return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents
    && event.senderFrame && event.senderFrame === window.webContents.mainFrame
    && navigationAllowed(event.senderFrame.url));
}

function rendererCsp(devUrl) {
  const connections = ["'self'"];
  if (devUrl) {
    const url = new URL(devUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("Invalid development renderer origin");
    connections.push(url.origin, `ws://127.0.0.1:${url.port}`);
  }
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connections.join(" ")}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

function installRendererCsp(session, rendererUrl, devUrl) {
  const expected = new URL(rendererUrl);
  session.webRequest.onHeadersReceived((details, callback) => {
    const target = new URL(details.url);
    const owned = devUrl ? target.origin === expected.origin : target.protocol === "file:" && target.href.split(/[?#]/)[0] === expected.href;
    const headers = { ...details.responseHeaders };
    if (owned) {
      for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-security-policy") delete headers[key];
      headers["Content-Security-Policy"] = [rendererCsp(devUrl)];
      headers["X-Frame-Options"] = ["DENY"];
    }
    callback({ responseHeaders: headers });
  });
}

module.exports = { trustedLauncherSender, rendererCsp, installRendererCsp };
