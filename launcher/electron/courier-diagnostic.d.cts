export function recordCourierFailure(root: string, worker: string, operation: string, requestFile: string, now?: number): void;
export function readCourierFailure(root: string, worker: string | undefined, since?: number): string | undefined;
export function acknowledgeCourierRecovery(root: string, worker: string, now?: number): void;
export const MESSAGE: string;
