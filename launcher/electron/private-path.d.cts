export function assertNoReparsePath(value: string): string;
export function assertWithinPrivateRoot(value: string, root: string): string;
export function ensurePrivateDirectory(value: string, options?: { recursive?: boolean; personalRoot?: string }): string;
export function protectPrivatePath(value: string, options?: { recursive?: boolean; personalRoot?: string }): string;
export function verifyPrivatePath(value: string, options?: { personalRoot?: string }): string;
export function windowsAclScript(recursive: boolean, verifyOnly: boolean): string;
