// Child process that resolves the whole graph and writes it (see build.ts).
//
// The resolved graph is the largest thing a build holds in memory. Built in a
// separate process, all of it goes back to the system when the process exits,
// before the analysis allocates its own structures.

import { rebuildGraph, useBuildCache } from './build.ts';
import { openDatabase } from './store/db.ts';

export interface RebuildRequest {
  database: string;
  key: string | null;
}

export type RebuildResponse = { ok: true } | { error: string };

process.once('message', (request: RebuildRequest) => {
  let response: RebuildResponse;
  try {
    const db = openDatabase(request.database, { key: request.key });
    try {
      useBuildCache(db);
      rebuildGraph(db);
    } finally {
      db.close();
    }
    response = { ok: true };
  } catch (error) {
    response = { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  process.send!(response, () => process.disconnect());
});
