import { START_COMMAND_FIRST_CHAR, START_COMMAND_MAX } from "@shared/board-schema";

// Mirrors the server's PATCH rules (server/api.ts) on the trimmed text, so the editor refuses what Save would.
export function startCommandProblem(text: string): string | null {
  const t = text.trim();
  if (t === "") return "A start command needs text.";
  if (!START_COMMAND_FIRST_CHAR.test(t)) {
    return 'A start command must begin with "/" or an ASCII letter or digit. The first character is restricted so a leading "-" cannot reach the CLI as a flag.';
  }
  if (t.length > START_COMMAND_MAX) {
    return `A start command is limited to ${String(START_COMMAND_MAX)} characters — this one is ${String(t.length)}.`;
  }
  return null;
}
