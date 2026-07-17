import {
  existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { withMutex, writeAtomic } from "./atomic-store.ts";
import { BoardSchema, DEFAULT_COLUMNS, slugifyBoardId, type Board } from "../shared/board-schema.ts";

function isEexistError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EEXIST";
}

export interface Storage {
  listBoardIds(): string[];
  getBoard(id: string): Board | null;
  getAllBoards(): Board[];
  withBoard<T>(id: string, fn: (b: Board | null) => { readonly board: Board | null; readonly result: T }): Promise<T>;
  /**
   * Lock TWO boards together for an atomic cross-board op (move a task). Reads both fresh inside one
   * combined critical section and writes both — so a concurrent single-board mutation can't be lost and
   * the task can't briefly exist on both boards. Locks are acquired in canonical (path-sorted) order so
   * two concurrent two-board ops can't deadlock; boardA is written before boardB. A same-id call
   * degrades to a single lock and writes boardA only. Never nest withBoard inside — async-mutex is
   * non-reentrant.
   */
  withBoards<T>(
    idA: string,
    idB: string,
    fn: (a: Board | null, b: Board | null) => { readonly boardA: Board | null; readonly boardB: Board | null; readonly result: T },
  ): Promise<T>;
  ensureFirstRunBoard(): Promise<void>;
  generateBoardId(label: string): string;
  /** Visible for testing — checks against a provided list instead of disk. */
  generateBoardIdAgainst(label: string, existing: readonly string[]): string;
}

export function createStorage(dataDir: string): Storage {
  const boardsDir = path.join(dataDir, "boards");

  function ensureDir(): void {
    mkdirSync(boardsDir, { recursive: true });
  }

  function boardPath(id: string): string {
    return path.join(boardsDir, `${id}.json`);
  }

  function readBoardFile(id: string): Board | null {
    const p = boardPath(id);
    if (!existsSync(p)) return null;
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    return BoardSchema.parse(raw);
  }

  function writeBoardFile(board: Board): void {
    ensureDir();
    writeAtomic(boardPath(board.id), JSON.stringify(board, null, 2));
  }

  function deleteBoardFile(id: string): void {
    const p = boardPath(id);
    if (existsSync(p)) unlinkSync(p);
  }

  function generateBoardIdAgainst(label: string, existing: readonly string[]): string {
    const base = slugifyBoardId(label);
    if (!existing.includes(base)) return base;
    for (let i = 2; i <= 99; i++) {
      const candidate = `${base}-${String(i)}`.slice(0, 32);
      if (!existing.includes(candidate)) return candidate;
    }
    return base; // extremely unlikely collision fallback
  }

  return {
    listBoardIds() {
      ensureDir();
      return readdirSync(boardsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5));
    },

    getBoard(id) {
      return readBoardFile(id);
    },

    getAllBoards() {
      return this.listBoardIds()
        .map((id) => readBoardFile(id))
        .filter((b): b is Board => b !== null);
    },

    async withBoard(id, fn) {
      return withMutex(boardPath(id), () => {
        const existing = readBoardFile(id);
        const { board, result } = fn(existing);
        if (board !== null) {
          writeBoardFile(board);
        } else if (existing !== null) {
          deleteBoardFile(id);
        }
        return result;
      });
    },

    async withBoards(idA, idB, fn) {
      const applyWrite = (id: string, existing: Board | null, next: Board | null): void => {
        if (next !== null) writeBoardFile(next);
        else if (existing !== null) deleteBoardFile(id);
      };
      // Two DISTINCT boards required — the only caller (move) no-ops when the ids match. Fail loud rather
      // than silently dropping boardB if a future caller forgets the guard.
      if (idA === idB) throw new Error("withBoards requires two distinct board ids");
      const pathA = boardPath(idA);
      const pathB = boardPath(idB);
      // Canonical (path-sorted) lock order so a concurrent move in the opposite direction can't deadlock.
      const [lock1, lock2] = pathA < pathB ? [pathA, pathB] : [pathB, pathA];
      return withMutex(lock1, () =>
        withMutex(lock2, () => {
          const a = readBoardFile(idA);
          const b = readBoardFile(idB);
          const { boardA, boardB, result } = fn(a, b);
          applyWrite(idA, a, boardA); // boardA first (the move caller passes the target here)
          applyWrite(idB, b, boardB);
          return result;
        }),
      );
    },

    async ensureFirstRunBoard() {
      ensureDir();
      if (this.listBoardIds().length > 0) return;
      const p = boardPath("personal");
      try {
        const fh = await open(p, "wx");
        const board: Board = {
          id: "personal", label: "Personal",
          columns: [...DEFAULT_COLUMNS], tasks: [],
        };
        await fh.writeFile(JSON.stringify(board, null, 2), "utf8");
        await fh.close();
      } catch (err: unknown) {
        if (!isEexistError(err)) throw err;
        // concurrent startup already created it — fine
      }
    },

    generateBoardId(label) {
      return generateBoardIdAgainst(label, this.listBoardIds());
    },

    generateBoardIdAgainst,
  };
}
