/** Picks verbatim lines out of the bots' logfmt logs for the terminal shots. */
export type TermLine = { ts: string; level: string; kind: string; rest: string; raw: string };

const LINE = /^(\S+Z) (\w+)\s+(\S+)\s*(.*)$/;

export function parseLine(raw: string): TermLine | null {
  const m = LINE.exec(raw);
  if (!m) return null;
  return { ts: m[1], level: m[2], kind: m[3], rest: m[4], raw };
}

function parsed(text: string): TermLine[] {
  return text.split("\n").map(parseLine).filter((l): l is TermLine => l !== null);
}

export function pickWindow(text: string, endKind: string, n: number): TermLine[] {
  const lines = parsed(text);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === endKind) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`no "${endKind}" line in the log — the runbook says pick another agent`);
  return lines.slice(Math.max(0, end - n + 1), end + 1);
}

export function pickByKinds(text: string, kinds: string[], n: number): TermLine[] {
  const set = new Set(kinds);
  const hits = parsed(text).filter((l) => set.has(l.kind));
  if (hits.length === 0) throw new Error(`no line of kind ${kinds.join("|")} in the log`);
  return hits.slice(-n);
}

/** Keys are never logged, but a shot is the one place a leak would be permanent. */
export function guard(lines: TermLine[]): TermLine[] {
  for (const l of lines) {
    const stripped = l.rest.replace(/\btx=0x[0-9a-fA-F]{64}\b/g, "");
    if (/0x[0-9a-fA-F]{64}/.test(stripped)) {
      throw new Error(`refusing to render a 64-hex value that is not a tx hash: ${l.raw.slice(0, 80)}…`);
    }
  }
  return lines;
}
