/** Resolve installed assets from source modules and flat distribution bundles. */
const packageUrl = new URL(import.meta.url.endsWith(".ts") ? "../../" : "../", import.meta.url);
export function distributionUrl(name: string): URL {
  return new URL(`dist/${name}`, packageUrl);
}
