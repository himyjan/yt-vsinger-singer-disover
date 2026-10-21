/// <reference types="vite/client" />

/**
 * The build-time environment variables this project uses.
 *
 * `vite/client` already types `import.meta.env` with an index signature, so
 * these helpers just narrow the values to `string`.
 */
export function envString(key: string): string {
  return (import.meta.env as Record<string, string | undefined>)[key] ?? "";
}
