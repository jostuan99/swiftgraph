// Runs Swift fact extraction on a pool of child processes.
//
// node-tree-sitter does not release the native memory of syntax trees
// reliably, so a child is replaced after a fixed number of files. Processes,
// not threads: memory a thread frees stays in this process (the allocator
// keeps it), while an exited process returns all of it to the system before
// the graph is resolved. The pool also parses files in parallel.

import { fork, type ChildProcess } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExtractRequest, ExtractResponse } from './worker.ts';

const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url));

export interface ExtractedFile {
  facts: Uint8Array;
  /** Imports and declarations only (see summary.ts). */
  summary: Uint8Array;
  digest: string;
  hasErrors: boolean;
}

export interface PoolOptions {
  workers?: number;
  /** Files a worker processes before it is replaced. */
  filesPerWorker?: number;
}

/**
 * Extracts the facts of the given absolute paths. Each result is handed to
 * `onResult` (with the index of its path) as soon as it arrives, in no
 * particular order, so the caller can store it and let it go.
 */
export async function extractInPool(
  paths: string[],
  options: PoolOptions,
  onResult: (index: number, result: ExtractedFile) => void,
): Promise<void> {
  if (paths.length === 0) return;
  const workerCount = Math.max(1, Math.min(options.workers ?? Math.min(availableParallelism() - 1, 8), paths.length));
  const filesPerWorker = options.filesPerWorker ?? 100;
  let next = 0;

  const runWorker = async (): Promise<void> => {
    while (next < paths.length) {
      // `advanced` serialization carries the Uint8Array results as bytes.
      const worker = fork(WORKER_PATH, [], {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        // tree-sitter's package.json triggers DEP0151 in every new process.
        execArgv: [...process.execArgv, '--disable-warning=DEP0151'],
      });
      try {
        for (let done = 0; done < filesPerWorker && next < paths.length; done++) {
          const index = next++;
          const response = await request(worker, { id: index, path: paths[index]! });
          if ('error' in response) throw new Error(`cannot extract ${paths[index]}: ${response.error}`);
          onResult(index, {
            facts: response.facts,
            summary: response.summary,
            digest: response.digest,
            hasErrors: response.hasErrors,
          });
        }
      } finally {
        await stop(worker);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
}

function request(worker: ChildProcess, message: ExtractRequest): Promise<ExtractResponse> {
  return new Promise((resolve, reject) => {
    const onMessage = (response: ExtractResponse) => {
      cleanup();
      resolve(response);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`extraction worker exited (${signal ?? `code ${code}`})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      worker.off('error', onError);
    };
    worker.on('message', onMessage);
    worker.on('exit', onExit);
    worker.on('error', onError);
    worker.send(message);
  });
}

function stop(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    worker.once('exit', () => resolve());
    worker.disconnect(); // the worker exits once its channel closes
  });
}
