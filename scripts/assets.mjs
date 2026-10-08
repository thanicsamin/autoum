export const nodeVersion = '24.21.0';
export const nodeHashes = {
  'linux-x64': '6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff',
  'win32-x64': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  'darwin-x64': '1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097',
  'darwin-arm64': 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057',
};
const release = 'M138.0.7204.303';
export const browserAssets = {
  'linux-x64': { version: release, url: `https://github.com/Alex313031/thorium/releases/download/${release}/thorium-browser_138.0.7204.303_SSE3.zip`, sha256: '31362085f7a0630fc935162cae5906eb39302c8f88aca2a1aa84581e3527bc50', cpu: 'SSE3' },
  'win32-x64': { version: release, url: `https://github.com/Alex313031/Thorium-Win/releases/download/${release}/thorium_SSE3_138.0.7204.303.zip`, sha256: '931468563186c4fb1d0f4f835a5b1399be18c3d1c399d7f78fb02d4f1b1a23a8', cpu: 'SSE3' },
  'darwin-x64': { version: release, url: `https://github.com/Alex313031/Thorium-MacOS/releases/download/${release}/Thorium_MacOS_x64.dmg`, sha256: '9a31c4d3fea1f6a49f2943f30d3400ef7cffbb8ab815567e83049b88652b8778' },
  'darwin-arm64': { version: release, url: `https://github.com/Alex313031/Thorium-MacOS/releases/download/${release}/Thorium_MacOS_ARM64.dmg`, sha256: '01f77352f40445e5c39a838c6e48198a09b64c14b0ec423c83fd9b461e0d7069' },
};
