function getAutostart() {
  return { supported: false, enabled: false };
}

function setAutostart(_app, enabled) {
  if (enabled === true) {
    throw new Error("Startup persistence is not part of CWC Personal. Launch CodexWeb Council manually.");
  }
  return { supported: false, enabled: false };
}

module.exports = {
  getAutostart,
  setAutostart,
};
