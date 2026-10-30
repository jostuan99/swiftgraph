// INPUT and OUTPUT of a screen in the output of `flows`: what it receives,
// who passes it, and the screens it pushes or presents.

import { tracedJson, valueSource } from './format-define.ts';
import type { ScreenView } from './define.ts';
import type { PassedArgument, ScreenInput, ScreenIO } from './screen-io.ts';

interface Location {
  file: string;
  line: number;
}

function where(at: Location): string {
  return `${at.file.split('/').at(-1)}:${at.line}`;
}

/** Rows joined by ` | `; `pretty` pads the columns. The location goes last. */
function table(rows: { cells: string[]; at?: string }[], pretty: boolean): string[] {
  if (!pretty) return rows.map((row) => ` ${row.cells.join(' | ').trimEnd()}${row.at ? ` ${row.at}` : ''}`);
  const widths: number[] = [];
  for (const row of rows) row.cells.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, cell.length)));
  const lines = rows.map((row) =>
    row.cells
      .map((cell, index) => cell.padEnd(widths[index]!))
      .join('  ')
      .trimEnd(),
  );
  const width = Math.max(0, ...lines.map((line) => line.length));
  return lines.map((line, index) => {
    const at = rows[index]!.at;
    return ` ${at ? `${line.padEnd(width)}  ${at}` : line}`;
  });
}

/** `item: row ← GET https://… items[]`; a source is added when it says more than the value. */
function passedText(argument: PassedArgument): string {
  const source = valueSource(argument.traced);
  // A literal or an unresolved value says nothing more than the value.
  const shown = source && source !== argument.value && !/^(unresolved|literal) /.test(source) ? ` ← ${source}` : '';
  // Set after creation: `viewModel = vm` (property), `configure(with:) row: item` (input method).
  if (argument.via === 'property') return `${argument.label} = ${argument.value}${shown}`;
  const via = argument.via ? `${argument.via} ` : '';
  return `${via}${argument.label === '_' ? '' : `${argument.label}: `}${argument.value}${shown}`;
}

/** `init(viewModel:)`, `configure configure(with:)`, `binding @Binding`, `memberwise`. */
function inputHow(input: ScreenInput): string {
  if (input.selector) return input.kind === 'init' ? input.selector : `${input.kind} ${input.selector}`;
  return input.attribute ? `${input.kind} @${input.attribute}` : input.kind;
}

/** INPUT: parameters with their type, how they are passed, the property they fill; then who passes them. */
export function screenInputLines(io: ScreenIO, view: ScreenView, pretty = false): string[] {
  const { inputs, callers } = io;
  const lines = [inputs.length === 0 ? 'INPUT none' : `INPUT (${inputs.length})`];
  const at = (location: Location) => (!pretty && location.file === view.file ? `:${location.line}` : where(location));
  if (inputs.length > 0) {
    lines.push(
      ...table(
        [
          { cells: ['param', 'type', 'how', 'default', 'into'] },
          ...inputs.map((input) => ({
            cells: [input.name, input.type ?? '', inputHow(input), input.default ?? '', input.property ?? ''],
            at: at(input.at),
          })),
        ],
        pretty,
      ),
    );
  }
  for (const caller of callers) {
    const passed = caller.arguments.map(passedText).join('; ');
    const how = [caller.selector, caller.transition].filter(Boolean).join(', ');
    lines.push(` from ${caller.from}${how ? ` (${how})` : ''}: ${passed || 'no arguments'} ${where(caller.at)}`);
  }
  return lines;
}

/** OUTPUT: each push or modal with what starts it, under which condition, and the values passed. */
export function screenOutputLines(io: ScreenIO, view: ScreenView, pretty = false): string[] {
  const outputs = io.outputs;
  if (outputs.length === 0) return ['OUTPUT none'];
  const rows = outputs.map((output) => ({
    cells: [
      output.id,
      `${output.transition}${output.via ? ` via ${output.via}` : ''}`,
      output.to,
      output.trigger.replaceAll(`${view.name}#`, '#'),
      output.when.join(' && '),
      output.arguments.map(passedText).join('; '),
    ],
    at: !pretty && output.at.file === view.file ? `:${output.at.line}` : where(output.at),
  }));
  return [
    `OUTPUT (${outputs.length})`,
    ...table([{ cells: ['id', 'transition', 'to', 'trigger', 'when', 'parameters'] }, ...rows], pretty),
  ];
}

export function screenIOJson(io: ScreenIO): Record<string, unknown> {
  return {
    inputs: io.inputs,
    callers: io.callers.map((caller) => ({ ...caller, arguments: caller.arguments.map(passedJson) })),
    outputs: io.outputs.map((output) => ({ ...output, arguments: output.arguments.map(passedJson) })),
  };
}

function passedJson(argument: PassedArgument): Record<string, unknown> {
  const source = valueSource(argument.traced);
  return {
    label: argument.label,
    value: argument.value,
    ...(source ? { source } : {}),
    ...(argument.traced.length > 0 ? { sources: argument.traced.map(tracedJson) } : {}),
  };
}
