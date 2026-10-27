// Output of `define`: text (for agents), json, markdown. Labels stay in English.

import { sourceGroup, type ConditionWrite, type ItemData, type ScreenDefinition, type ScreenItem } from './define.ts';
import { compactText } from './compact.ts';
import { tyText, type Location, type Step, type Traced } from './engine.ts';

export type DefineFormat = 'text' | 'compact' | 'json' | 'markdown';

export interface FormatOptions {
  /** Repository root given on the command line, repeated in the `flows` hints. */
  rootArgument?: string;
  /** Print full paths for every value (`--item`). */
  full?: boolean;
  /** Print DATA and CONDITIONS too (`--detail`, implied by `--item`). */
  detail?: boolean;
}

export function formatDefinition(definition: ScreenDefinition, format: DefineFormat, options: FormatOptions = {}): string {
  if (format === 'json') return JSON.stringify(definitionJson(definition), null, 2);
  if (format === 'markdown') return markdown(definition, options);
  if (format === 'compact') {
    compactMode = true;
    try {
      return compactText(text(definition, options));
    } finally {
      compactMode = false;
    }
  }
  return text(definition, options);
}

// --- Shared text ---------------------------------------------------------------------

function where(at: Location): string {
  return `${at.file.split('/').at(-1)}:${at.line}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** `['items', '[]', 'product_name']` → `items[].product_name`. */
export function jsonPathText(path: string[]): string {
  return path.reduce((text, key) => (key === '[]' ? `${text}[]` : text ? `${text}.${key}` : key), '');
}

/** `['items', '[]', 'name']` → `.items[].name`. */
function fieldText(fields: string[]): string {
  return fields.map((field) => (field === '[]' ? '[]' : `.${field}`)).join('');
}

/** Stored and remote data, most preferred first; other kinds of the project's rules come after them. */
export const DATASOURCE_PRIORITY = ['api', 'userDefaults', 'file', 'coreData', 'swiftData', 'keychain'];

/**
 * The one source of an item's data: stored or remote data first (in
 * `DATASOURCE_PRIORITY` order), then the view-model variable the view reads,
 * then a localized string, then a literal. `api ProductListResponse.items[].name`,
 * `ProductListViewModel.title`, `localization "Login"`. Empty when the item shows no data.
 */
export function datasource(item: ScreenItem): string {
  const candidates: { rank: number; text: string }[] = [];
  const consider = (traced: Traced) => {
    const origin = traced.origin;
    if (origin.kind === 'derived') return origin.inputs.forEach(consider);
    if (origin.kind === 'error') {
      candidates.push({ rank: DATASOURCE_PRIORITY.length + 1, text: shortSources(traced)[0]! });
      return;
    }
    if (origin.kind === 'source' && origin.direction !== 'write') {
      const kind = origin.source.replace(/^local\./, '');
      const index = DATASOURCE_PRIORITY.indexOf(kind);
      candidates.push({ rank: index >= 0 ? index : DATASOURCE_PRIORITY.length, text: shortSources(traced)[0]! });
      return;
    }
    const variable = viewModelVariable(traced);
    if (variable) candidates.push({ rank: 10, text: variable });
    else if (origin.kind === 'localization') candidates.push({ rank: 11, text: shortSources(traced)[0]! });
    else if (origin.kind !== 'unresolved') candidates.push({ rank: 12, text: shortSources(traced)[0]! });
  };
  for (const data of item.data) {
    if (data.action) continue;
    if (data.input) {
      (data.input.initialSources ?? []).forEach(consider);
      candidates.push({ rank: 10, text: data.input.property });
      continue;
    }
    data.traced.forEach(consider);
  }
  const best = candidates.reduce<{ rank: number; text: string } | undefined>(
    (chosen, candidate) => (!chosen || candidate.rank < chosen.rank ? candidate : chosen),
    undefined,
  );
  // An input's placeholder (or prompt) text, when localized: key, translations and missing languages.
  const placeholders = item.data
    .filter((data) => data.role === 'placeholder' || data.role === 'prompt')
    .flatMap((data) => data.traced.map((traced) => ({ role: data.role, traced })))
    .filter((entry) => entry.traced.origin.kind === 'localization')
    .map((entry) => `${entry.role} ${localizationText(entry.traced)}`);
  // With a prompt, SwiftUI shows the prompt as the placeholder; the first argument is the label.
  const prompted = placeholders.some((text) => text.startsWith('prompt '));
  const described = placeholders.map((text) =>
    prompted ? text.replace(/^placeholder /, 'label ').replace(/^prompt /, 'placeholder ') : text,
  );
  let main = best?.text ?? '';
  if (main.startsWith('localization ') && described.some((text) => text.includes(main))) main = '';
  return [main, ...described].filter((text) => text !== '').join('; ');
}

/** `localization "First Name" (en "First name", missing ja)`. */
function localizationText(traced: Traced): string {
  const origin = traced.origin;
  if (origin.kind !== 'localization') return shortSources(traced)[0] ?? '';
  const values = origin.values.filter((entry) => entry.value !== null).map((entry) => `${entry.language} ${quote(entry.value!)}`);
  const missing = origin.missing.length > 0 ? [`missing ${origin.missing.join(', ')}`] : [];
  const details = [...values, ...missing];
  return `localization ${quote(origin.key)}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

/** The property the view reads: the nearest one in the ViewModel layer, else the nearest property. */
export function viewModelVariable(traced: Traced): string {
  const properties = traced.steps.filter((step) => step.kind === 'property' && step.symbol);
  const viewModel = properties.filter((step) => step.layer === 'ViewModel').at(-1);
  return (viewModel ?? properties.filter((step) => step.layer !== 'View').at(-1))?.symbol ?? '';
}

/** `api ProductListResponse.items[].name`, `userDefaults "lastUpdated"`, `localization "Login"`. */
export function shortSources(traced: Traced): string[] {
  const origin = traced.origin;
  switch (origin.kind) {
    case 'source': {
      const kind = origin.source.replace(/^local\./, '');
      const type = origin.type ? tyText(origin.type).replace(/\?$/, '') : '';
      // A response: `GET https://api.example.com/v1/products items[].product_name`.
      if (kind === 'api') {
        const request = origin.endpoint ? `${origin.method ?? 'GET'} ${origin.endpoint}` : `api ${type || origin.api}`;
        return [traced.jsonPath ? `${request} ${jsonPathText(traced.jsonPath)}` : request];
      }
      // A key names stored data best (`userDefaults "lastUpdated"`); otherwise the type and the fields read.
      const value = `${type}${fieldText(traced.fields)}` || origin.api;
      if (origin.key && kind !== 'api' && kind !== 'file')
        return [`${kind} ${quote(origin.key)}${traced.fields.length > 0 ? fieldText(traced.fields) : ''}`];
      return [`${kind} ${value}`];
    }
    case 'localization':
      return [`localization ${quote(origin.key)}`];
    case 'literal':
      return [`literal ${origin.type === 'String' ? quote(origin.value) : origin.value}`];
    case 'case':
      return [`enum .${origin.name}`];
    case 'instance':
      return [`${origin.type}()`];
    case 'derived':
      return origin.inputs.flatMap(shortSources);
    case 'error': {
      const from = origin.sources.map((source) => shortSources(source)[0]!);
      return [`error ${from.length > 0 ? from.join(' | ') : origin.thrownBy.join(', ')}`];
    }
    case 'input':
      return ['input'];
    case 'unresolved':
      return ['unresolved'];
  }
}

/** One line for a traced value: kind, origin, fields and type. */
export function describeOrigin(traced: Traced): string {
  const origin = traced.origin;
  const fields = traced.fields.filter((field) => field !== '[]');
  const element = traced.fields.includes('[]') ? '[]' : '';
  const type = traced.type ? `: ${tyText(traced.type)}` : '';
  switch (origin.kind) {
    case 'literal':
      return `literal ${origin.type === 'String' ? quote(origin.value) : origin.value}${fields.length > 0 ? `.${fields.join('.')}` : ''}`;
    case 'case':
      return `enum ${origin.type ? `${origin.type}` : ''}.${origin.name}`;
    case 'localization': {
      const values = origin.values
        .filter((entry) => entry.value !== null)
        .map((entry) => `${entry.language} ${quote(entry.value!)}`)
        .join(', ');
      const missing = origin.missing.length > 0 ? `missing: ${origin.missing.join(', ')}` : '';
      return `localization  ${origin.table} ${quote(origin.key)}${values ? `  ${values}` : ''}${missing ? `  ${missing}` : ''}`;
    }
    case 'source': {
      const typeName = origin.type ? tyText(origin.type) : '?';
      const cast =
        !traced.failingCast && traced.type && origin.type && tyText(traced.type) !== typeName ? ` as ${tyText(traced.type)}` : '';
      const field = traced.fields.length > 0 ? `${typeName.replace(/\?$/, '')}${fieldText(traced.fields)}${type}` : `${typeName}${cast}`;
      const json = traced.jsonKey ? `  JSON ${quote(traced.jsonKey)}` : '';
      const endpoint = origin.endpoint ? `${origin.method ? `${origin.method} ` : ''}${quote(origin.endpoint)} → ` : '';
      const key = origin.key ? ` ${quote(origin.key)}` : '';
      return `${origin.source}${key}  ${endpoint}${origin.api} → ${field}${json}`;
    }
    case 'input':
      return `input → ${origin.property}${origin.type ? `: ${origin.type}` : ''}`;
    case 'instance':
      return `instance ${origin.call}${fields.length > 0 ? `.${fields.join('.')}${type}` : ''}`;
    case 'error':
      return `error${origin.type ? ` ${origin.type}` : ''}${fields.length > 0 ? `.${fields.join('.')}` : ''}  thrown by ${origin.thrownBy.join(', ') || '?'}${
        origin.sources.length > 0 ? `  (${origin.sources.map((source) => shortSources(source)[0]).join(', ')})` : ''
      }`;
    case 'derived':
      return `computed  ${origin.call}${fields.length > 0 ? `.${fields.join('.')}` : ''}`;
    case 'unresolved':
      return `unresolved  ${origin.reason}`;
  }
}

/** Steps worth a line: crossing a function, a closure, a cast, a write, a DI choice. */
function keySteps(traced: Traced, full: boolean): Step[] {
  const steps = [...traced.steps].reverse();
  if (full) return steps;
  return steps.filter((step) => ['param', 'closure', 'cast', 'return', 'write', 'property'].includes(step.kind));
}

function stepLine(step: Step): string {
  const layer = step.layer ? `[${step.layer}]` : '';
  const note = step.note && step.note.length <= 40 ? `  (${step.note})` : '';
  const async = step.async ? '  async' : '';
  const symbol = step.symbol && !step.text.startsWith(step.symbol) ? `  ${step.symbol}` : '';
  return `${step.text}${symbol}  ${layer}${note}${async}`.replace(/\s+$/, '');
}

function inputLines(traced: Traced): string[] {
  const origin = traced.origin;
  if (origin.kind === 'derived') return origin.inputs.map((input) => `from: ${describeOrigin(input)}  (${where(input.origin.at)})`);
  if (origin.kind !== 'source' || !origin.input) return [];
  return origin.input.map((input) => `value: ${describeOrigin(input)}  (${where(input.origin.at)})`);
}

// --- Text ------------------------------------------------------------------------------

/** Set while rendering the `compact` format: columns are not padded. */
let compactMode = false;

class Columns {
  readonly rows: { cells: string[]; at?: string }[] = [];
  /** Cell separator of the compact format, for tables with empty cells. */
  private readonly separator: string;
  constructor(separator = ' ') {
    this.separator = separator;
  }
  add(cells: string[], at?: string): void {
    this.rows.push({ cells, at });
  }
  render(indent: string): string[] {
    if (compactMode) {
      return this.rows.map((row) => `${indent}${row.cells.join(this.separator).trimEnd()}${row.at ? ` ${row.at}` : ''}`);
    }
    const widths: number[] = [];
    for (const row of this.rows) row.cells.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
    const lines = this.rows.map((row) =>
      row.cells
        .map((cell, index) => (index === row.cells.length - 1 && !row.at ? cell : cell.padEnd(widths[index]!)))
        .join('  ')
        .trimEnd(),
    );
    const width = Math.max(0, ...lines.map((line) => line.length));
    return lines.map((line, index) => {
      const at = this.rows[index]!.at;
      return `${indent}${at ? `${line.padEnd(width)}  ${at}` : line}`;
    });
  }
}

function shortId(item: ScreenItem, screen: string): string {
  return item.owner === screen ? `#${item.id.split('#').at(-1)}` : item.id;
}

function text(definition: ScreenDefinition, options: FormatOptions): string {
  const view = definition.view;
  const lines: string[] = [];
  const root = options.rootArgument ? ` --root ${options.rootArgument}` : '';
  lines.push(`${view.name}  [${view.kind}${view.layer ? `, layer ${view.layer}` : ''}]  ${view.file}:${view.line}`);
  const state = new Columns();
  for (const entry of definition.state) {
    state.add(
      [
        `${entry.attribute ? `@${entry.attribute} ` : ''}${entry.name}${entry.type ? `: ${entry.type}` : ''}${entry.value ? ` = ${entry.value}` : ''}`,
      ],
      where(entry.at),
    );
  }
  if (definition.state.length > 0) {
    const rendered = state.render('');
    lines.push(`  state:     ${rendered[0]}`, ...rendered.slice(1).map((line) => `             ${line}`));
  }
  lines.push(
    `  children:  ${definition.children.length === 0 ? 'none' : definition.children.map((child) => `${child.name} (${child.how}, ${where(child.at)})`).join('; ')}`,
  );

  lines.push('', `ITEMS (${definition.items.length})`);
  const items = new Columns(' | ');
  items.add(['id', 'line', 'kind', 'dir', 'when', 'datasource']);
  for (const item of definition.items) {
    items.add([
      compactMode
        ? `${shortId(item, view.name)}${item.parent ? ` (in ${item.parent.replace(`${view.name}#`, '#')})` : ''}`
        : `${item.id}${item.parent ? `  (in ${item.parent})` : ''}`,
      compactMode && item.at.file === view.file ? `:${item.at.line}` : where(item.at),
      item.kind,
      item.direction,
      item.shownWhen.join(' && '),
      datasource(item),
    ]);
  }
  lines.push(...items.render(' '));

  const detail = options.detail === true || options.full === true;
  if (!detail) {
    lines.push('', 'SUMMARY');
    lines.push(...summary(definition).map((line) => ` ${line}`));
    lines.push('', `More: --detail (DATA, CONDITIONS) or --item <id>`);
    return lines.join('\n');
  }
  lines.push('', 'DATA');
  const data = new Columns();
  for (const item of definition.items) {
    let first = true;
    for (const entry of item.data) {
      const label = first ? shortId(item, view.name) : '';
      first = false;
      for (const [index, line] of dataLines(entry, item, view.name, options, root).entries()) {
        data.add(index === 0 ? [label, entry.role, line.text] : ['', '', line.text], line.at);
      }
    }
    if (item.data.length === 0) data.add([shortId(item, view.name), '', 'no data'], where(item.at));
  }
  lines.push(...data.render(' '));

  if (definition.conditions.length > 0) {
    lines.push('', 'CONDITIONS');
    for (const condition of definition.conditions) {
      lines.push(
        ` ${condition.expression}${condition.type ? `: ${condition.type}` : ''}   (items ${itemRange(condition.items, view.name)})`,
      );
      const writes = new Columns();
      for (const write of condition.writes) writeLines(write, writes, options);
      lines.push(...writes.render('   '));
      lines.push(`   flows: swiftgraph flows ${view.name}${root}`);
    }
  }

  lines.push('', 'SUMMARY');
  lines.push(...summary(definition).map((line) => ` ${line}`));
  return lines.join('\n');
}

/** `LoginView#1`…`LoginView#6` → `#1–#6`; other screens keep their names. */
function itemRange(ids: string[], screen: string): string {
  const own = ids.filter((id) => id.startsWith(`${screen}#`)).map((id) => Number(id.split('#')[1]));
  const parts: string[] = [];
  for (let index = 0; index < own.length; index++) {
    let end = index;
    while (end + 1 < own.length && own[end + 1] === own[end]! + 1) end++;
    parts.push(end > index + 1 ? `#${own[index]}–#${own[end]}` : end === index + 1 ? `#${own[index]}, #${own[end]}` : `#${own[index]}`);
    index = end;
  }
  return [...parts, ...ids.filter((id) => !id.startsWith(`${screen}#`))].join(', ');
}

function dataLines(
  entry: ItemData,
  item: ScreenItem,
  screen: string,
  options: FormatOptions,
  root: string,
): { text: string; at?: string }[] {
  const lines: { text: string; at?: string }[] = [];
  if (entry.action) {
    lines.push({ text: entry.action.calls.join('; ') || entry.value, at: where(entry.action.at) });
    lines.push({ text: `flows: swiftgraph flows ${screen} --entry ${item.id}${root}` });
    return lines;
  }
  if (entry.input) {
    const input = entry.input;
    lines.push({
      text: `input → ${input.property}${input.type ? `: ${input.type}` : ''}${input.initial ? ` = ${input.initial}` : ''}`,
      at: where(input.at),
    });
    if (!input.readElsewhere) lines.push({ text: '⚠ not read anywhere else' });
    return lines;
  }
  if (entry.traced.length === 0) lines.push({ text: entry.value, at: where(entry.at) });
  for (const traced of entry.traced) {
    lines.push({ text: describeOrigin(traced), at: where(traced.origin.at) });
    if (options.full) for (const step of keySteps(traced, true)) lines.push({ text: `  ← ${stepLine(step)}`, at: where(step.at) });
    else {
      const via = keySteps(traced, false)
        .filter((step) => step.layer && step.kind !== 'property')
        .map((step) => `${step.symbol ?? step.text} [${step.layer}]`);
      const unique = via.filter((value, index) => via.indexOf(value) === index);
      if (unique.length > 0) lines.push({ text: `  → ${unique.reverse().join(' → ')}` });
    }
    for (const line of inputLines(traced)) lines.push({ text: `  ${line}` });
    for (const warning of new Set(traced.warnings)) lines.push({ text: `  ⚠ ${warning}` });
  }
  return lines;
}

function writeLines(write: ConditionWrite, columns: Columns, options: FormatOptions): void {
  const label = write.kind === 'initial' ? 'initial' : write.kind === 'init' ? 'init' : 'written';
  const value = /^\.\w+$/.test(write.value) ? `enum ${write.value}` : write.value;
  columns.add([label, `${value}${write.when.length > 0 ? `  when ${write.when.join(' && ')}` : ''}`], where(write.at));
  for (const traced of write.traced) {
    columns.add(['', `= ${describeOrigin(traced)}`], where(traced.origin.at));
  }
  const seen = new Set<string>();
  for (const traced of write.because) {
    for (const step of keySteps(traced, options.full === true)) {
      const line = `← ${stepLine(step)}`;
      if (seen.has(line)) continue;
      seen.add(line);
      columns.add(['', line], where(step.at));
      if (step.note && step.note.length > 40) columns.add(['', `    (${step.note})`]);
    }
    columns.add(['', `← ${describeOrigin(traced)}`], where(traced.origin.at));
    for (const line of inputLines(traced)) columns.add(['', `  ${line}`]);
  }
  const warnings = new Set(write.because.flatMap((traced) => traced.warnings));
  for (const warning of warnings) {
    columns.add(['', `⚠ ${warning}${write.unreachable === warning ? `: ${write.value} is never written` : ''}`]);
  }
}

function summary(definition: ScreenDefinition): string[] {
  const groups = new Map<string, Set<string>>();
  const add = (group: string, value: string) => {
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group)!.add(value);
  };
  const localization = new Map<string, { keys: Set<string>; missing: Map<string, number> }>();
  const inputs: { name: string; read: boolean }[] = [];
  const fieldGroups = new Map<string, Set<string>>();
  const visit = (traced: Traced) => {
    const group = sourceGroup(traced);
    const origin = traced.origin;
    if (origin.kind === 'localization') {
      const table = localization.get(origin.table) ?? { keys: new Set(), missing: new Map() };
      if (!table.keys.has(origin.key))
        for (const language of origin.missing) table.missing.set(language, (table.missing.get(language) ?? 0) + 1);
      table.keys.add(origin.key);
      localization.set(origin.table, table);
    } else if (group === 'unresolved') {
      add(group, `${origin.kind === 'unresolved' ? origin.reason : ''} (${where(origin.at)})`);
    } else if (group !== 'literal' && origin.kind === 'source') {
      // One entry per endpoint (or key) and API, with the fields read from it.
      const head = describeOrigin({ ...traced, fields: [], jsonKey: undefined, type: undefined }).replace(/^\S+\s+/, '');
      const fields =
        traced.fields.length > 0
          ? `${fieldText(traced.fields)}${traced.type ? `: ${tyText(traced.type)}` : ''}${traced.jsonKey ? ` ${quote(traced.jsonKey)}` : ''}`
          : '';
      const entries = fieldGroups.get(`${group}|${head}`) ?? new Set<string>();
      if (fields) entries.add(fields);
      fieldGroups.set(`${group}|${head}`, entries);
    }
    if (origin.kind === 'source') for (const input of origin.input ?? []) if (sourceGroup(input) !== 'literal') visit(input);
    if (origin.kind === 'derived') origin.inputs.forEach(visit);
    if (origin.kind === 'error') add('error', shortSources(traced)[0]!.replace(/^error /, ''));
  };
  for (const item of definition.items) {
    for (const data of item.data) {
      if (data.input)
        inputs.push({
          name: `${data.input.property.split('.').at(-1)}${data.input.type ? `: ${data.input.type}` : ''}`,
          read: data.input.readElsewhere,
        });
      data.traced.forEach(visit);
    }
  }
  for (const condition of definition.conditions) {
    for (const write of condition.writes) {
      write.traced.forEach(visit);
      write.because.forEach(visit);
    }
  }
  for (const [key, fields] of fieldGroups) {
    const [group, head] = key.split('|') as [string, string];
    add(group, fields.size > 0 ? `${head}  ${[...fields].join(', ')}` : head);
  }
  const lines = new Columns();
  for (const group of ['api', 'local', 'file']) lines.add([group, [...(groups.get(group) ?? [])].join('; ') || 'none']);
  for (const [group, values] of groups)
    if (!['api', 'local', 'file', 'unresolved'].includes(group)) lines.add([group, [...values].join('; ')]);
  lines.add([
    'localization',
    [...localization.entries()]
      .map(([table, entry]) => {
        const missing = [...entry.missing.entries()].map(([language, count]) => `${count} missing in ${language}`).join(', ');
        return `${table}: ${entry.keys.size} key${entry.keys.size === 1 ? '' : 's'}${missing ? ` (${missing})` : ''}`;
      })
      .join('; ') || 'none',
  ]);
  if (inputs.length > 0) {
    const unread = inputs.filter((input) => !input.read).length;
    lines.add(['input', `${inputs.map((input) => input.name).join(', ')}${unread > 0 ? `  (${unread} not read elsewhere)` : ''}`]);
  }
  lines.add(['unresolved', [...(groups.get('unresolved') ?? [])].join('; ') || 'none']);
  return lines.render('');
}

// --- Markdown ----------------------------------------------------------------------------

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function markdown(definition: ScreenDefinition, options: FormatOptions): string {
  const detail = options.detail === true || options.full === true;
  const view = definition.view;
  const lines = [`# ${view.name}`, '', `${view.kind}${view.layer ? `, layer ${view.layer}` : ''}, \`${view.file}:${view.line}\``, ''];
  lines.push(
    '## Items',
    '',
    `| id | line | kind | dir | when | datasource |${detail ? ' data |' : ''}`,
    `|---|---|---|---|---|---|${detail ? '---|' : ''}`,
  );
  for (const item of definition.items) {
    const data = item.data
      .map((entry) => {
        if (entry.action) return `${entry.role}: ${entry.action.calls.join('; ')}`;
        if (entry.input)
          return `${entry.role}: input → ${entry.input.property}${entry.input.readElsewhere ? '' : ' ⚠ not read anywhere else'}`;
        return `${entry.role}: ${entry.traced.map(describeOrigin).join('; ') || entry.value}`;
      })
      .join('<br>');
    lines.push(
      `| ${item.id} | \`${where(item.at)}\` | ${item.kind} | ${item.direction} | ${cell(item.shownWhen.join(' && '))} | ${cell(datasource(item))} |${detail ? ` ${cell(data)} |` : ''}`,
    );
  }
  if (detail && definition.conditions.length > 0) {
    lines.push('', '## Conditions', '', '| expression | type | items | value | when | where | source |', '|---|---|---|---|---|---|---|');
    for (const condition of definition.conditions) {
      for (const write of condition.writes) {
        const source = write.because.map(describeOrigin).join('; ');
        const warnings = [...new Set(write.because.flatMap((traced) => traced.warnings))].map((warning) => `⚠ ${warning}`).join('<br>');
        lines.push(
          `| ${cell(condition.expression)} | ${cell(condition.type ?? '')} | ${condition.items.join(', ')} | ${cell(write.value)} | ${cell(write.when.join(' && '))} | ${write.symbol} \`${where(write.at)}\` | ${cell(source)}${warnings ? `<br>${cell(warnings)}` : ''} |`,
        );
      }
    }
  }
  lines.push('', '## Summary', '', ...summary(definition).map((line) => `    ${line}`));
  return lines.join('\n');
}

// --- JSON ----------------------------------------------------------------------------------

function originJson(traced: Traced): Record<string, unknown> {
  const origin = traced.origin;
  const result: Record<string, unknown> = { kind: origin.kind === 'source' ? origin.source : origin.kind };
  switch (origin.kind) {
    case 'literal':
      result.type = origin.type;
      result.value = origin.value;
      break;
    case 'case':
      result.kind = 'enum';
      result.case = origin.name;
      if (origin.type) result.type = origin.type;
      break;
    case 'localization':
      result.table = origin.table;
      result.key = origin.key;
      result.missing = origin.missing;
      result.values = origin.values;
      break;
    case 'source':
      if (origin.type) result.type = tyText(origin.type);
      if (origin.key) result.key = origin.key;
      if (origin.endpoint) result.endpoint = origin.endpoint;
      if (origin.method) result.method = origin.method;
      result.call = origin.call;
      result.rule = origin.rule;
      if (origin.input) result.input = origin.input.map(tracedJson);
      break;
    case 'input':
      result.property = origin.property;
      break;
    case 'instance':
      result.type = origin.type;
      result.call = origin.call;
      break;
    case 'error':
      if (origin.type) result.type = origin.type;
      result.thrownBy = origin.thrownBy;
      result.sources = origin.sources.map(tracedJson);
      break;
    case 'derived':
      result.call = origin.call;
      result.inputs = origin.inputs.map(tracedJson);
      break;
    case 'unresolved':
      result.reason = origin.reason;
      break;
  }
  const fields = traced.fields.filter((field) => field !== '[]');
  if (fields.length > 0) result.field = fields.join('.');
  if (traced.fields.includes('[]')) result.element = true;
  if (traced.type && fields.length > 0) result.fieldType = tyText(traced.type);
  if (traced.jsonKey) result.jsonKey = traced.jsonKey;
  result.file = origin.at.file;
  result.line = origin.at.line;
  return result;
}

function tracedJson(traced: Traced): Record<string, unknown> {
  const result: Record<string, unknown> = { source: originJson(traced) };
  if (traced.steps.length > 0) {
    result.steps = [...traced.steps].reverse().map((step) => {
      const entry: Record<string, unknown> = { kind: step.kind, text: step.text, file: step.at.file, line: step.at.line };
      if (step.symbol) entry.symbol = step.symbol;
      if (step.layer) entry.layer = step.layer;
      if (step.note) entry.note = step.note;
      if (step.async) entry.async = true;
      return entry;
    });
  }
  if (traced.warnings.length > 0) result.warnings = [...new Set(traced.warnings)];
  return result;
}

function definitionJson(definition: ScreenDefinition): Record<string, unknown> {
  return {
    view: definition.view,
    state: definition.state,
    children: definition.children,
    items: definition.items.map((item) => ({
      id: item.id,
      ...(item.parent ? { parent: item.parent } : {}),
      path: item.path,
      kind: item.kind,
      direction: item.direction,
      shownWhen: item.shownWhen,
      datasource: datasource(item),
      file: item.at.file,
      line: item.at.line,
      data: item.data.map((data) => ({
        role: data.role,
        value: data.value,
        file: data.at.file,
        line: data.at.line,
        ...(data.input ? { input: data.input } : {}),
        ...(data.action ? { action: data.action } : {}),
        ...(data.traced.length > 0 ? { sources: data.traced.map(tracedJson) } : {}),
      })),
    })),
    conditions: definition.conditions.map((condition) => ({
      expression: condition.expression,
      property: condition.property,
      type: condition.type,
      items: condition.items,
      writes: condition.writes.map((write) => ({
        value: write.value,
        kind: write.kind,
        when: write.when,
        symbol: write.symbol,
        layer: write.layer,
        file: write.at.file,
        line: write.at.line,
        ...(write.traced.length > 0 ? { sources: write.traced.map(tracedJson) } : {}),
        ...(write.because.length > 0 ? { because: write.because.map(tracedJson) } : {}),
        ...(write.unreachable ? { unreachable: write.unreachable } : {}),
      })),
    })),
  };
}
