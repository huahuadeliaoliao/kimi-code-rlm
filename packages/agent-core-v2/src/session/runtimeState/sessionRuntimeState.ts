export function isNonPortableSessionRuntimePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return (
    normalized === 'rlm' ||
    normalized.startsWith('rlm/') ||
    /^agents\/[^/]+\/rlm(?:\/|$)/.test(normalized)
  );
}
