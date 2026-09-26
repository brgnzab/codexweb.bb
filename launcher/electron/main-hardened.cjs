const path = require("node:path");
const { WebContentsView, shell } = require("electron");
const browserHostModule = require("./browser-host.cjs");
const { assertPrivateRuntimeDataPath } = require("./runtime-state-policy.cjs");

const { BrowserHost, allowedAuthUrl } = browserHostModule;
const CHATGPT_PARTITION = "persist:codex-web-gpt-chatgpt";
const BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;

function validateConfiguredRuntimeRoots() {
  const sourceRoot = path.resolve(__dirname, "../..");
  const forbiddenRoots = [
    sourceRoot,
    process.resourcesPath ? path.resolve(process.resourcesPath) : "",
    path.dirname(process.execPath),
  ].filter(Boolean);
  for (const [name, rawValue] of [
    ["CODEX_CHATGPT_WEB_HOME", process.env.CODEX_CHATGPT_WEB_HOME],
    ["CODEX_WEB_GPT_LAUNCHER_DATA_DIR", process.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR],
  ]) {
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!value) continue;
    assertPrivateRuntimeDataPath(path.resolve(value), { label: name, forbiddenRoots });
  }
}

validateConfiguredRuntimeRoots();

function allowedAuthNavigationUrl(value) {
  if (allowedAuthUrl(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "chatgpt.com"
      && parsed.pathname.startsWith("/api/auth/");
  } catch {
    return false;
  }
}

const originalBindWebContents = BrowserHost.prototype.bindWebContents;

BrowserHost.prototype.bindWebContents = function bindHardenedWebContents() {
  originalBindWebContents.call(this);
  const contents = this.view.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedAuthUrl(url)) {
      try {
        this.createAuthView({}, url);
      } catch (error) {
        const message = `ChatGPT sign-in page failed to open: ${error instanceof Error ? error.message : String(error)}`;
        this.authNavigationError = new Error(message);
        this.logger.error("browser.auth_window_open_failed", { url, message });
        this.setState({ status: "error", message, url, loading: false });
      }
      return { action: "deny" };
    }
    let parsed;
    try { parsed = new URL(url); } catch { return { action: "deny" }; }
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      void shell.openExternal(parsed.toString()).catch((error) => {
        const message = `Could not open the external link: ${error instanceof Error ? error.message : String(error)}`;
        this.logger.error("browser.external_url_open_failed", { url: parsed.toString(), message });
        this.setState({ status: "error", message, loading: false });
      });
    } else {
      this.logger.warn("browser.external_url_rejected", { protocol: parsed.protocol });
    }
    return { action: "deny" };
  });
};

BrowserHost.prototype.createAuthView = function createHardenedAuthView(_options = {}, requestedUrl = "") {
  this.closeAuthView(this.authView, true);
  if (!allowedAuthUrl(requestedUrl)) throw new Error("Authentication URL is not allowed");

  const authView = new WebContentsView({
    webPreferences: {
      partition: CHATGPT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: true,
    },
  });
  this.authView = authView;
  this.authNavigationError = null;
  this.window.contentView.addChildView(authView);
  authView.setBounds(this.bounds);
  authView.setVisible(false);
  authView.webContents.setZoomFactor(this.state.zoomFactor);
  const contents = authView.webContents;

  const clearNavigationTimeout = () => {
    if (!authView.navigationTimeout) return;
    clearTimeout(authView.navigationTimeout);
    authView.navigationTimeout = null;
  };
  const armNavigationTimeout = (url) => {
    clearNavigationTimeout();
    authView.navigationTimeout = setTimeout(() => {
      authView.navigationTimeout = null;
      if (this.authView !== authView || contents.isDestroyed()) return;
      contents.stop();
      const message = "The ChatGPT sign-in page did not finish loading within 60 seconds. Check your connection and try again.";
      this.authNavigationError = new Error(message);
      this.logger.error("browser.auth_navigation_timeout", { url });
      this.closeAuthView(authView, true, false);
      this.setState({ status: "error", message, url, loading: false });
    }, BROWSER_NAVIGATION_TIMEOUT_MS);
    authView.navigationTimeout.unref?.();
  };

  armNavigationTimeout(requestedUrl);
  this.setState({ status: "loading", message: "Opening ChatGPT sign-in", url: requestedUrl, loading: true });

  const guardAuthNavigation = (event, url) => {
    if (allowedAuthNavigationUrl(url)) {
      armNavigationTimeout(url);
      return;
    }
    event.preventDefault();
    this.logger.warn("browser.auth_navigation_blocked", {});
  };
  contents.on("will-navigate", guardAuthNavigation);
  contents.on("will-redirect", guardAuthNavigation);
  contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
    if (mainFrame) armNavigationTimeout(url);
  });
  contents.on("did-start-loading", () => this.setState({ loading: true }));
  contents.on("did-stop-loading", () => {
    clearNavigationTimeout();
    this.setState({ loading: false });
  });
  contents.on("did-finish-load", () => {
    clearNavigationTimeout();
    this.setState({ url: contents.getURL(), loading: false });
    void this.probeAuthentication();
  });
  contents.on("page-title-updated", (_event, title) => {
    this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
  });
  contents.on("close", () => this.closeAuthView(authView, true));
  contents.on("destroyed", () => this.closeAuthView(authView, false));
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
    if (!mainFrame || errorCode === -3) return;
    clearNavigationTimeout();
    const message = `ChatGPT sign-in page failed to load: ${errorDescription}`;
    this.authNavigationError = new Error(message);
    this.logger.error("browser.auth_navigation_failed", { errorCode, errorDescription, url });
    this.closeAuthView(authView, true, false);
    this.setState({ status: "error", message, url, loading: false });
  });
  contents.on("render-process-gone", (_event, details) => {
    clearNavigationTimeout();
    const message = `ChatGPT sign-in renderer stopped: ${details.reason}`;
    this.authNavigationError = new Error(message);
    this.logger.error("browser.auth_renderer_gone", { reason: details.reason, exitCode: details.exitCode });
    this.closeAuthView(authView, false);
    this.setState({ status: "error", message, loading: false });
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedAuthNavigationUrl(url)) {
      armNavigationTimeout(url);
      void contents.loadURL(url).catch((error) => {
        if (error && typeof error === "object" && error.code === "ERR_ABORTED") return;
        if (this.authView !== authView || contents.isDestroyed()) return;
        clearNavigationTimeout();
        const message = `ChatGPT sign-in page failed to open: ${error instanceof Error ? error.message : String(error)}`;
        this.authNavigationError = new Error(message);
        this.logger.error("browser.auth_window_open_failed", { url, message });
        this.closeAuthView(authView, true, false);
        this.setState({ status: "error", message, url, loading: false });
      });
    }
    return { action: "deny" };
  });

  this.syncViewVisibility();
  this.logger.info("browser.auth_surface_opened");
  void contents.loadURL(requestedUrl).catch((error) => {
    if (error && typeof error === "object" && error.code === "ERR_ABORTED") return;
    if (this.authView !== authView || contents.isDestroyed()) return;
    clearNavigationTimeout();
    const message = `ChatGPT sign-in page failed to open: ${error instanceof Error ? error.message : String(error)}`;
    this.authNavigationError = new Error(message);
    this.logger.error("browser.auth_window_open_failed", { url: requestedUrl, message });
    this.closeAuthView(authView, true, false);
    this.setState({ status: "error", message, url: requestedUrl, loading: false });
  });
  return contents;
};

require("./main-council.cjs");
