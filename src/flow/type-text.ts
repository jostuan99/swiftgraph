// Swift type text, parsed to the shape data flow needs: a dotted name with
// generic arguments. Function and tuple types stay opaque.

export interface TypeText {
  /** Dotted name without generic arguments: `AnyPublisher`, `Mapper.ResponseEntity`; raw text when opaque. */
  name: string;
  args: TypeText[];
  optional?: boolean;
  /** Function, tuple or other type kept as written. */
  opaque?: boolean;
}

export function parseTypeText(written: string): TypeText {
  let text = written
    .trim()
    .replace(/^(some|any|inout|borrowing|consuming)\s+/, '')
    .replace(/^@\w+\s+/, '');
  let optional = false;
  while (/[?!]$/.test(text)) {
    optional = true;
    text = text.slice(0, -1).trim();
  }
  const result = parseInner(text);
  if (optional) result.optional = true;
  return result;
}

function parseInner(text: string): TypeText {
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1);
    const parts = splitTopLevel(inner, ':');
    if (parts.length === 2) return { name: 'Dictionary', args: [parseTypeText(parts[0]!), parseTypeText(parts[1]!)] };
    return { name: 'Array', args: [parseTypeText(inner)] };
  }
  if (text.startsWith('(') || text.includes('->')) return { name: text, args: [], opaque: true };
  // `Optional<T>`
  const segments: string[] = [];
  let args: TypeText[] = [];
  let depth = 0;
  let current = '';
  let argText = '';
  for (const char of text) {
    if (char === '<') {
      if (depth > 0) argText += char;
      depth++;
      continue;
    }
    if (char === '>') {
      depth--;
      if (depth > 0) argText += char;
      else args = splitTopLevel(argText, ',').map(parseTypeText);
      continue;
    }
    if (depth > 0) {
      argText += char;
      continue;
    }
    if (char === '.') {
      segments.push(current.trim());
      current = '';
      // Arguments of an inner segment (`Published<T>.Publisher`) stay with the last segment that had them.
      argText = '';
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  const name = segments.filter((segment) => segment !== '').join('.');
  if (name === 'Optional' && args.length === 1) return { ...args[0]!, optional: true };
  if (!/^[A-Za-z_][\w.]*$/.test(name)) return { name: text, args: [], opaque: true };
  return { name, args };
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') depth++;
    if (char === '>' || char === ')' || char === ']') depth--;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

export function printTypeText(type: TypeText): string {
  if (type.opaque) return type.name + (type.optional ? '?' : '');
  let text: string;
  if (type.name === 'Array' && type.args.length === 1) text = `[${printTypeText(type.args[0]!)}]`;
  else if (type.name === 'Dictionary' && type.args.length === 2)
    text = `[${printTypeText(type.args[0]!)}: ${printTypeText(type.args[1]!)}]`;
  else text = type.args.length > 0 ? `${type.name}<${type.args.map(printTypeText).join(', ')}>` : type.name;
  return type.optional ? `${text}?` : text;
}
