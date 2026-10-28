// Output of `flows`: text (for agents), json, markdown, Mermaid sequence diagrams.

import { compactText } from './compact.ts';
import type { FlowOutcome, FlowStep, ScreenFlow, ScreenFlows } from './flows.ts';

export type FlowsFormat = 'text' | 'compact' | 'pretty' | 'json' | 'markdown' | 'mermaid';

/** `steps`: every step in execution order instead of the summary (text and markdown). */
/**
 * `steps`: every step in execution order; `calls`: the numbered calls through
 * the layers; otherwise the data view (one step per get/set of data).
 */
export function formatFlows(result: ScreenFlows, format: FlowsFormat, options: { steps?: boolean; calls?: boolean } = {}): string {
  if (format === 'json') return JSON.stringify(result, null, 2);
  if (format === 'mermaid') return mermaid(result);
  if (format === 'markdown') return markdown(result);
  if (format === 'pretty') return options.steps ? text(result) : summaryText(result);
  // `text` and `compact` spend fewer tokens: no padding, a legend, the screen's name left out.
  const output = options.steps ? text(result) : options.calls ? leanSummary(result) : dataView(result);
  return compactText(output, { tight: format === 'compact' });
}

/**
 * The short form: for each flow the call path, what it writes on success
 * (with the mapping from response fields), what it does on failure, and what it stores.
 */
/**
 * The summary with few tokens: the layer only when it changes, the screen's
 * own name left out of steps and titles, outcomes under their step.
 */
/** The data view: each get/set of a datasource or view-model variable, with what success and failure change. */
function dataView(result: ScreenFlows): string {
  const view = result.view;
  const screen = (text: string) => text.split(`${view.name}.`).join('').replaceAll(`${view.name}#`, '#');
  const lines = [`${view.name} [${view.kind}] ${view.file}:${view.line}`];
  const empty: string[] = [];
  for (const flow of result.flows) {
    const id = flow.id.startsWith(`${view.name}/`) ? flow.id.slice(view.name.length + 1) : flow.id;
    const data = flow.summary.data;
    if (data.length === 0) {
      empty.push(id);
      continue;
    }
    lines.push('', `${id} ${flow.kind} ${screen(flow.title)} ${where(flow.at)}`);
    for (const step of data) {
      const notes = step.notes.length > 0 ? ` (${step.notes.map((note) => note.replaceAll(`${view.name}#`, '#')).join('; ')})` : '';
      lines.push(`${step.number} ${step.kind === 'viewModel' ? 'set ' : ''}${step.text}${notes} ${where(step.at)}`);
      const block = (title: string, outcomes: FlowOutcome[]) => {
        if (outcomes.length === 0) return;
        lines.push(`    ${title}`);
        for (const outcome of outcomes)
          for (const line of outcomeLines({ ...outcome, nested: false }, view.name)) lines.push(`      ${line}`);
      };
      block('success', step.success);
      block('failure', step.failure);
      if (step.stops) lines.push(`    ⚠ stops: ${step.stops}`);
    }
    const inline = data.flatMap((step) => [step.stops ?? '', ...[...step.success, ...step.failure].map((outcome) => outcome.never ?? '')]);
    for (const warning of new Set(flow.summary.warnings.filter((warning) => !inline.includes(warning)))) lines.push(`⚠ ${warning}`);
  }
  if (empty.length > 0) lines.push('', `No data access: ${empty.join(', ')}`);
  lines.push('', 'More: --calls (calls through the layers), --steps (every step)');
  return lines.join('\n');
}

function leanSummary(result: ScreenFlows): string {
  const view = result.view;
  const screen = (text: string) => text.split(`${view.name}.`).join('').replaceAll(`${view.name}#`, '#');
  const lines = [`${view.name} [${view.kind}] ${view.file}:${view.line}`];
  for (const flow of result.flows) {
    const summary = flow.summary;
    const id = flow.id.startsWith(`${view.name}/`) ? flow.id.slice(view.name.length + 1) : flow.id;
    lines.push('', `${id} ${flow.kind} ${screen(flow.title)} ${where(flow.at)}`);
    const unhandled: string[] = [];
    const width = String(summary.steps.length).length;
    let layer: string | undefined;
    for (const step of summary.steps) {
      // Step numbers in the first column, the step right after its number; outcomes indented under it.
      const indent = '';
      const gutter = ' '.repeat(width + 1);
      const notes = step.notes.filter((note) => !/^[A-Z]+ "|^"|^key |^write$/.test(note));
      const tag = step.layer && step.layer !== layer ? ` [${step.layer}]` : '';
      layer = step.layer ?? layer;
      lines.push(
        `${String(step.number).padStart(width)} ${indent}${tag.trimStart()}${tag ? ' ' : ''}${step.when ? `if ${step.when} → ` : ''}${screen(step.text)}${notes.length > 0 ? ` (${notes.join('; ')})` : ''} ${where(step.at)}`,
      );
      const block = (title: string, outcomes: FlowOutcome[]) => {
        if (outcomes.length === 0) return;
        lines.push(`${gutter}${indent}  ${title}`);
        for (const outcome of outcomes) for (const line of outcomeLines(outcome, view.name)) lines.push(`${gutter}${indent}    ${line}`);
      };
      if (step.handledBy !== undefined) lines.push(`${gutter}${indent}  success/failure → ${step.handledBy}`);
      else if (
        step.failable &&
        step.failure.length === 0 &&
        !summary.steps.some((other) => other.number < step.number && other.depth < step.depth && other.failure.length > 0)
      ) {
        unhandled.push(`${screen(step.text)}: error not handled`);
      }
      block('success', step.success);
      block('failure', step.failure);
      block('writes', step.writes);
      if (step.stops) lines.push(`${gutter}${indent}  ⚠ stops: ${step.stops}`);
    }
    const inline = summary.steps.flatMap((step) => [
      step.stops ?? '',
      ...[...step.success, ...step.failure, ...step.writes].map((outcome) => outcome.never ?? ''),
    ]);
    for (const warning of new Set([...unhandled, ...summary.warnings.filter((warning) => !inline.includes(warning))]))
      lines.push(`⚠ ${warning}`);
  }
  lines.push('', 'More: --steps');
  return lines.join('\n');
}

function summaryText(result: ScreenFlows, compact = false): string {
  const view = result.view;
  const lines = [`${view.name}  [${view.kind}${view.layer ? `, layer ${view.layer}` : ''}]  ${view.file}:${view.line}`];
  for (const flow of result.flows) {
    const summary = flow.summary;
    lines.push('', `${flow.id}  ${flow.kind}  ${flow.title}  ${where(flow.at)}`);
    const rows: { head: string; text: string; at?: string }[] = [];
    const unhandled: string[] = [];
    const width = String(summary.steps.length).length;
    const layerWidth = Math.max(0, ...summary.steps.map((step) => (step.layer ? step.layer.length + 2 : 0)));
    for (const step of summary.steps) {
      const indent = '  '.repeat(step.depth);
      const notes = step.notes.filter((note) => !/^[A-Z]+ "|^"|^key |^write$/.test(note));
      rows.push({
        head: `${String(step.number).padStart(width)} ${(step.layer ? `[${step.layer}]` : '').padEnd(layerWidth)}`,
        text: `${indent}${step.when ? `if ${step.when} → ` : ''}${step.text}${notes.length > 0 ? `  (${notes.join('; ')})` : ''}`,
        at: where(step.at),
      });
      // Outcomes sit under their step; the compact format does not pad them to the step's text column.
      const pad = compact ? '' : ' '.repeat(width + 1 + layerWidth);
      const block = (title: string, outcomes: FlowOutcome[]) => {
        if (outcomes.length === 0) return;
        rows.push({ head: pad, text: `${indent}  ${title}` });
        for (const outcome of outcomes)
          for (const line of outcomeLines(outcome, view.name)) rows.push({ head: pad, text: `${indent}    ${line}` });
      };
      block('success', step.success);
      block('failure', step.failure.length > 0 || !step.failable ? step.failure : []);
      // A request inside a call whose error is ignored or caught is covered by that call.
      const covered = summary.steps.some((other) => other.number < step.number && other.depth < step.depth && other.failure.length > 0);
      if (step.handledBy !== undefined) rows.push({ head: pad, text: `${indent}  success/failure → step ${step.handledBy}` });
      else if (step.failable && step.failure.length === 0 && !covered) unhandled.push(`${step.text}: error not handled`);
      block('writes', step.writes);
      if (step.stops) rows.push({ head: pad, text: `${indent}  ⚠ stops: ${step.stops}` });
    }
    const textWidth = Math.max(0, ...rows.filter((row) => row.at).map((row) => row.head.length + row.text.length + 2));
    for (const row of rows)
      lines.push(row.at ? ` ${`${row.head}  ${row.text}`.padEnd(textWidth)}  ${row.at}` : ` ${row.head}  ${row.text}`);
    // Each warning once; a cast already shown where the flow stops or a write never runs is not repeated.
    const inline = summary.steps.flatMap((step) => [
      step.stops ?? '',
      ...[...step.success, ...step.failure, ...step.writes].map((outcome) => outcome.never ?? ''),
    ]);
    const warnings = [...unhandled, ...summary.warnings.filter((warning) => !inline.includes(warning))];
    section(
      lines,
      'warnings',
      [...new Set(warnings)].map((warning) => `⚠ ${warning}`),
    );
  }
  lines.push('', 'More: --steps');
  return lines.join('\n');
}

function section(lines: string[], title: string, entries: string[]): void {
  entries.forEach((entry, index) => lines.push(`  ${(index === 0 ? title : '').padEnd(8)} ${entry}`));
}

function outcomeLines(outcome: FlowOutcome, screen = ''): string[] {
  const when = outcome.nested ? '  ↳ ' : outcome.when ? `${outcome.when} → ` : '';
  const shown =
    outcome.shown.length > 0 ? `  → ${screen ? itemRange(outcome.shown).replaceAll(`${screen}#`, '#') : itemRange(outcome.shown)}` : '';
  const never = outcome.never ? `  ⚠ never runs: ${outcome.never}` : '';
  const mapping = outcome.mapping;
  if (outcome.ignored) return [`try? → ${outcome.target}  ⚠ error ignored: nothing is shown or stored on failure`];
  if (!outcome.value) return [`${when}${outcome.target}${outcome.empty ? '  ⚠ empty' : ''}`];
  // A literal (`nil`, `[]`, `.main`) reads best as written.
  const literal = !mapping || mapping.from.length === 0 || mapping.from.every((source) => /^(literal|enum) /.test(source));
  const from = literal ? outcome.value : mapping.from.join(' | ');
  const mapped = mapping?.mappedTo ? `  (map → [${mapping.mappedTo}])` : '';
  const lines = [`${when}${outcome.target} ← ${from}${mapped}${shown}${never}`];
  for (const field of mapping?.fields ?? []) lines.push(`    .${field.field} ← ${field.from}${field.computed ? '  (formatted)' : ''}`);
  return lines;
}

function where(at: { file: string; line: number }): string {
  return `${at.file.split('/').at(-1)}:${at.line}`;
}

function stepText(step: FlowStep): string {
  const when = step.when ? `${/^catch\b/.test(step.when) ? '' : 'if '}${step.when} → ` : '';
  const notes = step.notes.length > 0 ? `  (${step.notes.join('; ')})` : '';
  const warnings = step.warnings.map((warning) => `  ⚠ ${warning}`).join('');
  const async = step.async && step.kind !== 'closure' ? '  await' : '';
  return `${when}${step.text}${notes}${async}${warnings}`;
}

function flowLines(flow: ScreenFlow): { number: string; layer: string; text: string; at: string }[] {
  const rows: { number: string; layer: string; text: string; at: string }[] = [];
  let number = 0;
  for (const step of flow.steps) {
    const numbered = step.kind === 'call' || step.kind === 'source';
    if (numbered) number++;
    rows.push({
      number: numbered ? String(number) : '',
      layer: step.layer ? `[${step.layer}]` : '',
      text: `${'  '.repeat(step.depth)}${stepText(step)}`,
      at: where(step.at),
    });
  }
  return rows;
}

/** `A#1, A#2, A#3` → `A#1–#3`. */
function itemRange(ids: string[]): string {
  const parts: string[] = [];
  for (let index = 0; index < ids.length; index++) {
    const [owner, number] = ids[index]!.split('#') as [string, string];
    let end = index;
    while (end + 1 < ids.length && ids[end + 1] === `${owner}#${Number(ids[end]!.split('#')[1]) + 1}`) end++;
    parts.push(end > index + 1 ? `${owner}#${number}–#${ids[end]!.split('#')[1]}` : ids.slice(index, end + 1).join(', '));
    index = end;
  }
  return parts.join(', ');
}

function text(result: ScreenFlows): string {
  const view = result.view;
  const lines = [`${view.name}  [${view.kind}${view.layer ? `, layer ${view.layer}` : ''}]  ${view.file}:${view.line}`];
  lines.push(`FLOWS (${result.flows.length})`);
  const width = Math.max(0, ...result.flows.map((flow) => flow.id.length));
  const kindWidth = Math.max(0, ...result.flows.map((flow) => flow.kind.length));
  for (const flow of result.flows)
    lines.push(` ${flow.id.padEnd(width)}  ${flow.kind.padEnd(kindWidth)}  ${flow.title}  ${where(flow.at)}`);
  for (const flow of result.flows) {
    lines.push('', `${flow.id}  ${flow.kind}  ${flow.title}`);
    const rows = flowLines(flow);
    const numberWidth = Math.max(1, ...rows.map((row) => row.number.length));
    const layerWidth = Math.max(0, ...rows.map((row) => row.layer.length));
    const body = rows.map((row) => ` ${row.number.padStart(numberWidth)} ${row.layer.padEnd(layerWidth)}  ${row.text}`);
    const textWidth = Math.max(0, ...body.map((line) => line.length));
    rows.forEach((row, index) => lines.push(`${body[index]!.padEnd(textWidth)}  ${row.at}`));
    if (flow.errors.length > 0) lines.push(`  errors: ${flow.errors.join('; ')}`);
    if (flow.writes.length > 0) {
      lines.push(
        `  writes: ${flow.writes.map((write) => `${write.property}${write.values.length > 0 ? ` (${write.values.join(', ')})` : ''}`).join(', ')}`,
      );
      lines.push(
        `  shown:  ${flow.shown.map((shown) => `${shown.property.split('.').at(-1)} → ${shown.items.length > 0 ? itemRange(shown.items) : 'not shown on this screen'}`).join('; ')}`,
      );
    }
  }
  return lines.join('\n');
}

function markdown(result: ScreenFlows): string {
  const lines = [`# ${result.view.name} flows`, ''];
  for (const flow of result.flows) {
    lines.push(`## ${flow.id} ${flow.kind}: ${flow.title}`, '', '| # | layer | step | where |', '|---|---|---|---|');
    for (const row of flowLines(flow)) {
      lines.push(
        `| ${row.number} | ${row.layer} | ${row.text.replace(/^( +)/, (spaces) => '&nbsp;'.repeat(spaces.length)).replace(/\|/g, '\\|')} | \`${row.at}\` |`,
      );
    }
    if (flow.errors.length > 0) lines.push('', `Errors: ${flow.errors.join('; ')}`);
    if (flow.writes.length > 0) lines.push('', `Writes: ${flow.writes.map((write) => `\`${write.property}\``).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** One sequence diagram per flow; participants are the architecture layers. */
function mermaid(result: ScreenFlows): string {
  const blocks: string[] = [];
  for (const flow of result.flows) {
    const lines = ['sequenceDiagram', `  title ${flow.id} ${flow.kind}: ${flow.title.replace(/[;#]/g, ' ')}`];
    const callers: string[] = [];
    const participants: string[] = [];
    const name = (layer: string | undefined) => (layer ?? 'Code').replace(/[^\w]/g, '_');
    for (const step of flow.steps) {
      const layer = name(step.layer);
      if (!participants.includes(layer)) participants.push(layer);
      callers[step.depth] = layer;
      if (step.depth === 0 || (step.kind !== 'call' && step.kind !== 'source')) continue;
      const from = callers[step.depth - 1] ?? layer;
      const label = `${step.text}${step.notes.length > 0 ? ` (${step.notes.join('; ')})` : ''}`.replace(/[;#]/g, ' ');
      lines.push(`  ${from}->>${layer}: ${step.async ? 'await ' : ''}${label}`);
    }
    lines.splice(2, 0, ...participants.map((participant) => `  participant ${participant}`));
    blocks.push(['```mermaid', ...lines, '```'].join('\n'));
  }
  return blocks.join('\n\n');
}
