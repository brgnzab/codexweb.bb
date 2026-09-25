// Current browser-helper compatibility only: the launcher-owned ChatGPT worker still uses this
// marker path when validating previously stored browser state. Standalone login/setup behavior was
// removed with the legacy terminal runtime.
export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}
