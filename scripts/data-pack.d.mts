export function readPack(bytes: Uint8Array): { encoding: number; resources: Map<number, Buffer> };
export function writePack(pack: { encoding: number; resources: Map<number, Uint8Array> }): Buffer;
