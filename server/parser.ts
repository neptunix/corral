function shortenModel(m: string): string {
  if (m.includes("Opus")) return "Opus";
  if (m.includes("1M")) return "Sonnet 1M";
  if (m.includes("Sonnet")) return "Sonnet";
  if (m.includes("Haiku")) return "Haiku";
  return m.slice(0, 14);
}

export function parsePane(text: string): {
  ctxPct: string | null;
  model: string | null;
  sessionName: string | null;
} {
  let ctxPct: string | null = null;
  let model: string | null = null;
  let sessionName: string | null = null;

  for (const line of text.split("\n")) {
    const statusRegex = /ctx\s+[█░]+\s+(\d+)%.*\|\s+(.+?)(?:\s*\/rc|\s*$)/;
    const status = statusRegex.exec(line);
    const pct = status?.[1];
    const mdl = status?.[2];
    if (pct !== undefined && mdl !== undefined && ctxPct === null) {
      ctxPct = pct;
      model = shortenModel(mdl.trim());
    }
    const dashCount = line.split("─").length - 1;
    if (line.length > 60 && dashCount / line.length > 0.6) {
      const nameRegex = /─{3,}\s+([^\s─][^─]*?)\s+─{2,}\s*$/;
      const nameMatch = nameRegex.exec(line);
      const name = nameMatch?.[1];
      if (name !== undefined) sessionName = name.trim();
    }
  }
  return { ctxPct, model, sessionName };
}
