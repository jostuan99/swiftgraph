// Entry points of the data-flow queries shared by the CLI and the MCP server.

import type { Db } from '../store/db.ts';
import { clipToBudget } from '../query/text.ts';
import { defineScreen, type DefineOptions } from './define.ts';
import { FlowEngine } from './engine.ts';
import { formatDefinition, type DefineFormat } from './format-define.ts';
import { screenFlows, type FlowsOptions } from './flows.ts';
import { formatFlows, type FlowsFormat } from './format-flows.ts';

export interface DefineRequest extends DefineOptions {
  screen: string;
  /** DATA and CONDITIONS too. */
  detail?: boolean;
  depth?: number;
  format?: DefineFormat;
  budget?: number;
  /** Root as given by the user, repeated in hints. */
  rootArgument?: string;
}

/** `define <screen>` as text, json or markdown. Throws `RuleError` for a bad swiftgraph.json. */
export function defineText(db: Db, root: string, request: DefineRequest): string {
  const engine = new FlowEngine(db, root);
  if (request.depth !== undefined) engine.depthLimit = request.depth;
  const result = defineScreen(engine, request.screen, request);
  if ('candidates' in result) return [result.message, ...result.candidates.map((candidate) => `  ${candidate}`)].join('\n');
  const format = request.format ?? 'text';
  const output = formatDefinition(result.definition, format, {
    full: request.item !== undefined,
    detail: request.detail === true,
    ...(request.rootArgument ? { rootArgument: request.rootArgument } : {}),
  });
  return format === 'json' || request.budget === undefined ? output : clipToBudget(output, request.budget);
}

export interface FlowsRequest extends FlowsOptions {
  screen: string;
  /** Every step instead of the summary. */
  steps?: boolean;
  format?: FlowsFormat;
  budget?: number;
}

/** `flows <screen>` as text, json, markdown or Mermaid. */
export function flowsText(db: Db, root: string, request: FlowsRequest): string {
  const engine = new FlowEngine(db, root);
  const result = screenFlows(engine, request.screen, request);
  if ('candidates' in result) return [result.message, ...result.candidates.map((candidate) => `  ${candidate}`)].join('\n');
  const format = request.format ?? 'text';
  const output = formatFlows(result.flows, format, { steps: request.steps === true });
  return format === 'json' || request.budget === undefined ? output : clipToBudget(output, request.budget);
}
