import type { SessionLink } from "@shared/board-schema";

import { CLOSING_STATUS } from "./optimistic";

export interface TreeLink {
  readonly env: string;
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly spawnedBy?: SessionLink["spawnedBy"];
  readonly live: { readonly detached: boolean; readonly status: string } | null;
}

export type SessionItem<T extends TreeLink> =
  | { readonly kind: "session"; readonly link: T; readonly children: readonly SessionItem<T>[] }
  | { readonly kind: "folded"; readonly links: readonly T[] };

export const FOLD_MIN_CLOSED = 6;
const MAX_DEPTH = 3;

interface Node<T> { readonly link: T; readonly children: Node<T>[] }

// A close still in flight stays unfolded: its row hosts the modal that reports a failed close.
const isClosed = (l: TreeLink): boolean => l.live?.detached === true && l.live.status !== CLOSING_STATUS;

function parentIndex(links: readonly TreeLink[], child: TreeLink): number {
  const by = child.spawnedBy;
  if (by === undefined || by === "operator") return -1;
  const bySid = links.findIndex((l) => l.sessionId === by.sessionId);
  if (bySid !== -1) return bySid;
  // A spawned parent's link has no sessionId until the reconciler backfills it.
  return links.findIndex((l) => l.sessionId === null && l.env === by.env && l.paneId === by.paneId);
}

function buildForest<T extends TreeLink>(links: readonly T[]): Node<T>[] {
  const nodes = links.map((link): Node<T> => ({ link, children: [] }));
  const parents = links.map((l, i) => {
    const p = parentIndex(links, l);
    return p === i ? -1 : p;
  });
  const visited = new Set<number>();
  const attach = (i: number): Node<T> | undefined => {
    const node = nodes[i];
    if (node === undefined || visited.has(i)) return undefined;
    visited.add(i);
    parents.forEach((p, c) => {
      if (p !== i) return;
      const child = attach(c);
      if (child !== undefined) node.children.push(child);
    });
    return node;
  };
  const roots: Node<T>[] = [];
  parents.forEach((p, i) => {
    if (p !== -1) return;
    const root = attach(i);
    if (root !== undefined) roots.push(root);
  });
  // Whatever a spawnedBy cycle left unreached still gets a row.
  links.forEach((_, i) => {
    const root = attach(i);
    if (root !== undefined) roots.push(root);
  });
  return roots;
}

function subtree<T>(n: Node<T>): T[] {
  return [n.link, ...n.children.flatMap(subtree)];
}

const hasLive = <T extends TreeLink>(n: Node<T>): boolean => subtree(n).some((l) => !isClosed(l));

function toItems<T extends TreeLink>(siblings: readonly Node<T>[], depth: number, fold: boolean): SessionItem<T>[] {
  const ordered = [...siblings.filter(hasLive), ...siblings.filter((n) => !hasLive(n))];
  const items: SessionItem<T>[] = [];
  let folded: T[] = [];
  for (const n of ordered) {
    if (fold && !hasLive(n)) { folded = [...folded, ...subtree(n)]; continue; }
    const children = depth + 2 >= MAX_DEPTH
      ? n.children.flatMap(subtree).map((link): Node<T> => ({ link, children: [] }))
      : n.children;
    items.push({ kind: "session", link: n.link, children: toItems(children, depth + 1, fold) });
  }
  if (folded.length > 0) items.push({ kind: "folded", links: folded });
  return items;
}

/** `fold` asks to fold; it applies only once the card holds FOLD_MIN_CLOSED closed sessions. */
export function sessionItems<T extends TreeLink>(links: readonly T[], fold: boolean): SessionItem<T>[] {
  const folding = fold && foldable(links);
  return toItems(buildForest(links), 0, folding);
}

export function foldable(links: readonly TreeLink[]): boolean {
  return links.filter(isClosed).length >= FOLD_MIN_CLOSED;
}
