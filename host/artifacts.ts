import { access, mkdir, cp } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { dataDir } from './storage.ts';

export const defaultArtifactsDir = join(homedir(), 'autoum', 'artifacts');
const legacyArtifactsDir = resolve('/autoum/artifacts');
export let artifactsDir = resolve(process.env.AUTOUM_ARTIFACTS_DIR || defaultArtifactsDir);
export function setArtifactsDir(path?: string) {
  if (path !== undefined && (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) throw Error('Choose an absolute artifacts folder.');
  artifactsDir = resolve(process.env.AUTOUM_ARTIFACTS_DIR || path || defaultArtifactsDir);
}
export const artifactInstructions = () => `Save files you create for the user in ${artifactsDir}, organized by chat when useful. This includes HTML, Markdown, documents, images and other generated deliverables. Use absolute paths and link the final file. Keep follow-up edits in the same file. Honor an explicit destination requested by the user and edit existing project/source files in place. Downloads and account/session/memory data are separate. Never silently substitute another output folder if the artifacts folder is unavailable.`;
export async function ensureArtifacts() {
  try { await mkdir(artifactsDir, { recursive: true, mode: 0o700 }); await access(artifactsDir, constants.W_OK); }
  catch { throw Error(`The output folder ${artifactsDir} is not writable. Choose a writable Artifacts folder in Settings.`); }
}
export async function initializeArtifacts(path?: string) {
  setArtifactsDir(path);
  let migrated = false;
  try { await ensureArtifacts(); }
  catch (error) {
    // Upgrade the old unwritable default without overriding custom folders or env settings.
    if (process.env.AUTOUM_ARTIFACTS_DIR || !path || artifactsDir !== legacyArtifactsDir) throw error;
    setArtifactsDir(); await ensureArtifacts(); migrated = true;
  }
  await migrateReports();
  return migrated;
}
export async function migrateReports() {
  await ensureArtifacts();
  // Copy old saved reports so existing browser links continue to work.
  const old = join(dataDir, 'research');
  if (old !== artifactsDir) await cp(old, artifactsDir, { recursive: true, force: false, errorOnExist: false }).catch((error: any) => { if (error.code !== 'ENOENT') throw error; });
}
