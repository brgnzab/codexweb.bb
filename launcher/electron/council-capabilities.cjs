const { isCouncilRuntimeLive } = require("./council-runtime-evidence.cjs");

function capabilityUnavailable(configured = false) {
  return {
    available: false,
    state: configured ? "degraded" : "idle",
    reason: { code: "CAPABILITY_UNAVAILABLE", retryable: true },
  };
}

function capabilityReady() {
  return { available: true, state: "ready" };
}

function deriveCouncilCapabilities(input = {}) {
  const configured = input.configured === true;
  const mode = input.mode === "full" ? "full" : input.mode === "browser-only" ? "browser-only" : null;
  // Explicit positive evidence is accepted for focused tests/callers, but persisted false values
  // never override the live main-process evidence owned by RuntimeSupervisor.
  const runtimeLive = input.runtimeLive === true || isCouncilRuntimeLive();
  const runtimeCapability = runtimeLive ? capabilityReady() : capabilityUnavailable(configured);
  const optionalMcpCapability = mode === "full"
    ? runtimeCapability
    : capabilityUnavailable(false);

  return {
    secureTunnel: { ...optionalMcpCapability },
    localRepo: capabilityUnavailable(false),
    githubConnector: capabilityUnavailable(false),
    fullMcp: { ...optionalMcpCapability },
    wakeEngine: { ...runtimeCapability },
  };
}

module.exports = { deriveCouncilCapabilities };
