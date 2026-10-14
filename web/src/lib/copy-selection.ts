// Claude Code's message markers sit in the 2-col gutter it indents every line by.
const GUTTER_MARKER = /^[●⏺❯](?= )/;

function asIndent(line: string): string {
  return line.replace(GUTTER_MARKER, " ");
}

function indentOf(line: string): number {
  return asIndent(line).search(/[^ ]|$/);
}

// The n > 0 guard keeps a column-0 marker that is content, not gutter.
function stripIndent(line: string, n: number): string {
  return n > 0 ? asIndent(line).slice(Math.min(n, indentOf(line))) : line;
}

// TUIs pad rows with real spaces to the pane width, so xterm copies them as content.
export function cleanSelection(text: string, startCol: number): string {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const counted = lines.filter((l, i) => l.length > 0 && !(startCol > 0 && i === 0));
  const shared = counted.length > 0 ? Math.min(...counted.map(indentOf)) : 0;
  return lines.map((l, i) => stripIndent(l, i === 0 ? Math.max(0, shared - startCol) : shared)).join("\n");
}
