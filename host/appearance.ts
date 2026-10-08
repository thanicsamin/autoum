import { readJson, dataDir } from './storage.ts';
import { join } from 'node:path';
export function browserTheme(preferences: any): 'system' | 'light' | 'dark' {
  // Chromium ThemeService::BrowserColorScheme: 0 system, 1 light, 2 dark.
  const theme = preferences?.browser?.theme || preferences?.account_values?.browser?.theme;
  const scheme = theme?.color_scheme2 ?? theme?.user_color_scheme;
  return scheme === 1 ? 'light' : scheme === 2 ? 'dark' : 'system';
}
export async function readBrowserTheme() {
  const profile = process.env.AUTOUM_PROFILE_DIR || join(dataDir, 'browser-profile');
  return browserTheme(await readJson(join(profile, 'Default/Preferences'), {}).catch(() => ({})));
}
