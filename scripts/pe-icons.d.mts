export function peIcons(bytes: Buffer): { signed: boolean; icons: Map<string, any>; groups: any[]; checksumOffset: number };
export function replacePEIcons(bytes: Buffer, replacements: Map<string, Map<number, Buffer>>): { bytes: Buffer; changed: number };
