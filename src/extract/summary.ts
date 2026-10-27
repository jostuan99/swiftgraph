// Declaration summary of a file: what other files can depend on.

import { encodeFacts } from '../store/facts-codec.ts';
import { createHash } from 'node:crypto';
import type { Declaration, FileFacts } from '../schema/types.ts';

export interface DeclarationSummary {
  imports: string[];
  declarations: Declaration[];
}

/**
 * Digest of everything that identifies or resolves declarations: names,
 * selectors, parameters, types, inheritance, modifiers, attributes and `#if`
 * conditions. Positions and doc comments are excluded, so editing a function
 * body or a comment keeps the digest.
 */
export function declarationDigest(facts: FileFacts): string {
  const relevant = facts.declarations.map((declaration) => {
    const { range: _range, doc: _doc, ...rest } = declaration;
    return rest;
  });
  return createHash('sha256')
    .update(JSON.stringify({ imports: facts.imports, declarations: relevant }))
    .digest('hex');
}

export function encodeSummary(facts: FileFacts): Uint8Array {
  const summary: DeclarationSummary = { imports: facts.imports, declarations: facts.declarations };
  return encodeFacts(summary);
}
