export interface WindowsPlan {
  browser: string; name: string; executable: string; folder: string; host: string;
  target: string; profile: string; data: string; extension: string; companion: string;
  helper: string; manifestPath: string; registry: { key: string; view: number }[];
}
export interface WindowsOptions { browser?: string; localAppData?: string; destination?: string; configRoot?: string; runtimeRoot?: string; importData?: string }
export function windowsExtensionPlan(options?: WindowsOptions): WindowsPlan;
export function windowsRegistryValue(output: string): string | undefined;
export function windowsWorker(bytes: Buffer, host: string, previous?: { version?: string; extensionWorker?: string; workerRevision?: number }): { bytes: Buffer; extensionWorker: string; workerRevision: number; extensionVersion: string };
export function installWindowsExtension(options?: WindowsOptions): Promise<{ browser: string; extensionId: string; extension: string; helper: string; data: string; profile: string; host: string }>;
export function uninstallWindowsExtension(options?: WindowsOptions): Promise<{ browser: string; removed: boolean; dataPreserved?: string }>;
