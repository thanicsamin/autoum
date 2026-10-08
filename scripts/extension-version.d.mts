export type WorkerIdentity = { extensionWorker: string; workerRevision: number; extensionVersion: string };
export function extensionWorkerIdentity(bytes: Uint8Array, previous?: { version?: string; extensionWorker?: string; workerRevision?: unknown }, version?: string): WorkerIdentity;
