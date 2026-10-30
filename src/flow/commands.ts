// Entry points of the data-flow queries shared by the CLI and the MCP server.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../store/db.ts';
import { clipToBudget } from '../query/text.ts';
import { defineScreen, type DefineOptions } from './define.ts';
import { FlowEngine } from './engine.ts';
import { formatDefinition, type DefineFormat } from './format-define.ts';
import { screenFlows, type FlowsOptions } from './flows.ts';
import { formatFlows, type FlowsFormat } from './format-flows.ts';
import { CONFIG_FILES, configPath, readRuleFile, ruleTemplate, RuleError } from '../rules/load.ts';
import { Document, isScalar, visit } from 'yaml';
import { RULE_KINDS, type RuleKind } from '../rules/types.ts';

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
  /** The numbered calls through the layers instead of the data view (implied by `until` and `layers`). */
  calls?: boolean;
  format?: FlowsFormat;
  budget?: number;
}

/** `flows <screen>` as text, json, markdown or Mermaid. */
export function flowsText(db: Db, root: string, request: FlowsRequest): string {
  const engine = new FlowEngine(db, root);
  const result = screenFlows(engine, request.screen, request);
  if ('candidates' in result) return [result.message, ...result.candidates.map((candidate) => `  ${candidate}`)].join('\n');
  const format = request.format ?? 'text';
  const output = formatFlows(result.flows, format, {
    steps: request.steps === true,
    calls: request.calls === true || request.until !== undefined || (request.layers?.length ?? 0) > 0,
  });
  return format === 'json' || request.budget === undefined ? output : clipToBudget(output, request.budget);
}

/** Rule kinds printed by `rules` when none are named: INPUT and OUTPUT of `flows`, and the default language. */
export const SCREEN_RULE_KINDS: RuleKind[] = ['inputs', 'navigation', 'localization'];

/**
 * `rules`: the effective rules of the project as a YAML rule file to copy and
 * edit. With `write`, they go into the project's rule file (`swiftgraph.yaml`
 * when it has none); its other keys (other rule kinds, `disable`) are kept.
 * Throws `RuleError` for an unknown kind.
 */
export function rulesText(db: Db, root: string, kinds: string[] = SCREEN_RULE_KINDS, write = false): string {
  const all = kinds.includes('all');
  for (const kind of kinds) {
    if (!all && !(RULE_KINDS as readonly string[]).includes(kind))
      throw new RuleError(`unknown rule kind "${kind}" (kinds: ${RULE_KINDS.join(', ')}, all)`);
  }
  const engine = new FlowEngine(db, root);
  let template: Record<string, unknown> = { ...ruleTemplate(engine.rules, all ? RULE_KINDS : (kinds as RuleKind[])) };
  // The default language found in the project, as a rule to change, for each module no rule covers.
  if (Array.isArray(template.localization)) {
    const found = new Map<string, string>();
    for (const table of engine.localizationTables())
      if (table.defaultLanguage && !engine.defaultLanguage(table.module, table.table)) found.set(table.module, table.defaultLanguage);
    for (const [module, defaultLanguage] of [...found].sort())
      template.localization.push({ id: `project.default-language.${module}`, module, defaultLanguage });
  }
  const existing = configPath(root);
  // The project's file was read when the rules were loaded: it is valid.
  if (write && existing) template = { ...readRuleFile(existing), ...template };
  if (!write) return yamlText(template);
  // An existing JSON file stays JSON.
  const path = existing ?? join(root, CONFIG_FILES[0]);
  writeFileSync(path, `${path.endsWith('.json') ? jsonText(template) : yamlText(template)}\n`);
  return `wrote ${path}`;
}

/** YAML with one rule per line: `- { id: uikit.push, call: "*.pushViewController(_:animated:)", destination: [0] }`. */
function yamlText(template: Record<string, unknown>): string {
  const document = new Document(template);
  visit(document, {
    Seq(_, node) {
      // `extends` and other lists of names on one line; each rule on its own line.
      if (node.items.every((item) => isScalar(item))) node.flow = true;
    },
    Map(_, node, path) {
      if (path.length > 1) node.flow = true;
    },
  });
  const header =
    '# swiftgraph rules: edit a rule and keep its id to replace the preset rule; list ids under `disable` to turn rules off.\n';
  return `${header}${document.toString({ lineWidth: 0, flowCollectionPadding: true }).trimEnd()}`;
}

/** JSON with one rule per line, as in the presets. */
function jsonText(template: Record<string, unknown>): string {
  const entries = Object.entries(template).map(([key, value]) => {
    if (!Array.isArray(value) || !value.some((rule) => typeof rule === 'object')) return `  ${JSON.stringify(key)}: ${inline(value)}`;
    return `  ${JSON.stringify(key)}: [\n${value.map((rule) => `    ${inline(rule)}`).join(',\n')}\n  ]`;
  });
  return `{\n${entries.join(',\n')}\n}`;
}

/** JSON on one line with spaces: `{ "id": "uikit.push", "destination": [0] }`. */
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (value && typeof value === 'object') {
    const fields = Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}: ${inline(field)}`);
    return fields.length === 0 ? '{}' : `{ ${fields.join(', ')} }`;
  }
  return JSON.stringify(value);
}
