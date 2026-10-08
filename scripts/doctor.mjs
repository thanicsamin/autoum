import { statfs } from 'node:fs/promises';
import { freemem, totalmem, cpus } from 'node:os';
import { root, nodePath, browserPath, profileDir } from './paths.mjs';
const disk = await statfs(root); const gib = n => (n / 1024 ** 3).toFixed(1);
console.log(`Node: ${nodePath}\nRAM: ${gib(freemem())} GiB free / ${gib(totalmem())} GiB total\nDisk: ${gib(disk.bavail * disk.bsize)} GiB free\nCPU threads: ${cpus().length}\nProfile: ${profileDir}`);
try { console.log(`Thorium: ${await browserPath()}`); } catch (e) { console.log(e.message); }
console.log(Number(gib(disk.bavail * disk.bsize)) < 100 ? 'Chromium source build: insufficient disk space (100 GB minimum).' : 'Chromium source build: minimum disk space available.');
