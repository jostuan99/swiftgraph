// The `compact` format of `define` and `flows`: the text format with fewer
// tokens, for agents. Same content, without column padding, with a location
// that repeats the file only when it changes, and with long names that recur
// (an API host, a view model, DI bindings) written once in a legend.

const LOCATION = /(\S+\.swift):(\d+)$/;

export function compactText(text: string): string {
  const legend: string[] = [];
  let body = text;

  // An API host used more than once: `GET /v1/products` with `api = https://…` in the legend.
  const hosts = new Map<string, number>();
  for (const match of body.matchAll(/https?:\/\/[^/\s"')]+/g)) hosts.set(match[0], (hosts.get(match[0]) ?? 0) + 1);
  const repeatedHosts = [...hosts].filter(([, count]) => count > 1).map(([host]) => host);
  if (repeatedHosts.length === 1) {
    legend.push(`api = ${repeatedHosts[0]}`);
    body = body.split(repeatedHosts[0]!).join('');
  }

  // DI bindings: once in the legend instead of on every step that uses them.
  const bindings = new Set<string>();
  body = body.replace(/\s*\(((?:[^()]|\([^()]*\))*DI: (?:[^()]|\([^()]*\))*)\)/g, (_, inside: string) => {
    const parts = inside.split(/;\s*/);
    const rest: string[] = [];
    for (const part of parts) {
      if (part.startsWith('DI: ')) bindings.add(part.slice(4).replace(/\s{2,}/g, ' '));
      else rest.push(part);
    }
    return rest.length > 0 ? ` (${rest.join('; ')})` : '';
  });
  if (bindings.size > 0) legend.push(`di: ${[...bindings].join('; ')}`);

  // A view model named again and again: `vm.rows` with `vm = ProductListViewModel`.
  const viewModels = new Map<string, number>();
  for (const match of body.matchAll(/\b([A-Z]\w*ViewModel)\.(?!swift\b)/g)) viewModels.set(match[1]!, (viewModels.get(match[1]!) ?? 0) + 1);
  const aliases = [...viewModels].filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]);
  aliases.forEach(([name], index) => {
    const alias = aliases.length === 1 ? 'vm' : `vm${index + 1}`;
    legend.push(`${alias} = ${name}`);
    body = body.replace(new RegExp(`\\b${name}\\.(?!swift\\b)`, 'g'), `${alias}.`);
  });

  // Padding inside lines becomes one space; nesting keeps one space per level.
  let lastFile = '';
  const lines = body.split('\n').map((line) => {
    const indent = /^ */.exec(line)![0].length;
    let rest = line.slice(indent).replace(/ {2,}/g, ' ').trimEnd();
    const location = LOCATION.exec(rest);
    if (location) {
      const [whole, file, number] = location;
      rest = `${rest.slice(0, rest.length - whole.length).trimEnd()} @${file === lastFile ? '' : file}:${number}`;
      lastFile = file!;
    }
    return `${' '.repeat(Math.ceil(indent / 2))}${rest}`;
  });
  const header = lines.findIndex((line) => line !== '');
  if (legend.length > 0) lines.splice(header + 1, 0, ...legend.map((entry) => `# ${entry}`));
  return lines.filter((line, index) => line !== '' || (lines[index - 1] ?? '') !== '').join('\n');
}
