// xterm clears a forced selection on any mouse report it sends; Safari's buttonless move before mouseup is one.
export function attachForcedSelectionGuard(container: HTMLElement): () => void {
  let selecting = false;

  const onDown = (e: MouseEvent): void => {
    selecting = e.button === 0 && (e.altKey || e.shiftKey);
  };
  const onUp = (): void => { selecting = false; };
  const onMove = (e: MouseEvent): void => {
    if (selecting && e.buttons === 0) e.stopPropagation();
  };
  const onWheel = (e: WheelEvent): void => {
    if (selecting) e.stopPropagation();
  };

  container.addEventListener("mousedown", onDown, true);
  container.addEventListener("mousemove", onMove, true);
  container.addEventListener("wheel", onWheel, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("blur", onUp);
  return () => {
    container.removeEventListener("mousedown", onDown, true);
    container.removeEventListener("mousemove", onMove, true);
    container.removeEventListener("wheel", onWheel, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("blur", onUp);
  };
}
