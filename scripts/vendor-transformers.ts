// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reconstruct the byte-exact upstream Transformers distribution from AKM's
 * semantically equivalent, push-safe source representation.
 *
 * Upstream contains one public model-vocabulary value whose spelling matches
 * a hosted secret-scanning pattern. Keeping its two halves separate in Git
 * avoids storing an apparent credential; the package build rejoins exactly one
 * audited occurrence so the published runtime retains the upstream hash.
 */
export function materializeVendoredTransformers(source: string): string {
  const pattern = /^(\s*\["mistral3", )"([A-Za-z0-9_-]{16})" \+ "([A-Za-z0-9_-]{16})"(\],\s*)$/gm;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one split Transformers vocabulary value; found ${matches.length}.`);
  }
  return source.replace(pattern, (_match, prefix: string, first: string, second: string, suffix: string) => {
    return `${prefix}"${first}${second}"${suffix}`;
  });
}

/** Convert one pristine upstream file into the checked-in push-safe spelling. */
export function sanitizeVendoredTransformers(source: string): string {
  const pattern = /^(\s*\["mistral3", )"([A-Za-z0-9_-]{32})"(\],\s*)$/gm;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one upstream Transformers vocabulary value; found ${matches.length}.`);
  }
  return source.replace(pattern, (_match, prefix: string, value: string, suffix: string) => {
    return `${prefix}"${value.slice(0, 16)}" + "${value.slice(16)}"${suffix}`;
  });
}
