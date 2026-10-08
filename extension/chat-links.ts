// Keep relative/local links clickable without allowing script or data URLs.
export const chatLinkPattern = /^(?:(?:https?|file):|[a-z]:[\\/]|(?:[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)))/i;
export function chatLinkUrl(href: string, { cwd, home, artifactsDir }: { cwd?: string; home?: string; artifactsDir?: string } = {}): URL {
  if (!href.trim()) throw Error('This link has no destination.');
  let value = href.trim();
  if (value.startsWith('~/') && home) value = home.replace(/\/$/, '') + value.slice(1);
  if (/^[a-z]:[\\/]/i.test(value)) value = 'file:///' + value.replaceAll('\\', '/');
  let url: URL;
  if (value.startsWith('/') && !value.startsWith('//')) url = new URL('file://' + value);
  else if (value.startsWith('//')) url = new URL('https:' + value);
  else if (/^[a-z][a-z\d+.\-]*:/i.test(value)) url = new URL(value);
  else {
    let folder = cwd || artifactsDir;
    if (!folder) throw Error('This relative file link needs a working folder.');
    folder = folder.replaceAll('\\', '/');
    url = new URL(value, 'file://' + (/^[a-z]:\//i.test(folder) ? '/' : '') + folder.replace(/\/$/, '') + '/');
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw Error('This link cannot be opened as a browser page.');
  return url;
}
