export function sealRuntimeManifest(root: string, identity: Record<string, unknown>): { manifest: Record<string, unknown>; manifestHash: string };
export function verifyRuntimeContent(root: string, trustedManifestHash: string): Record<string, unknown>;
export function sha256(bytes: string | Uint8Array): string;
export function inventory(root: string): Record<string, string>;
