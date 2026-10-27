// Child process that extracts the facts of Swift files (see pool.ts).
//
// Receives `{ id, path }` messages and answers `{ id, facts, hasErrors }` with
// encoded facts (store/facts-codec.ts), or `{ id, error }`.

import { readFileSync } from 'node:fs';
import { encodeFacts } from '../store/facts-codec.ts';
import { declarationDigest, encodeSummary } from './summary.ts';
import { extractSwiftFacts } from './swift.ts';

export interface ExtractRequest {
  id: number;
  path: string;
}

export type ExtractResponse =
  { id: number; facts: Uint8Array; summary: Uint8Array; digest: string; hasErrors: boolean } | { id: number; error: string };

process.on('message', (request: ExtractRequest) => {
  let response: ExtractResponse;
  try {
    const facts = extractSwiftFacts(readFileSync(request.path, 'utf8'));
    response = {
      id: request.id,
      facts: encodeFacts(facts),
      summary: encodeSummary(facts),
      digest: declarationDigest(facts),
      hasErrors: facts.hasErrors,
    };
  } catch (error) {
    response = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  process.send!(response);
});
