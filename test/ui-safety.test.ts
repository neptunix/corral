import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

describe("UI safety — recap never reaches dangerouslySetInnerHTML", () => {
  it("App.tsx: no dangerouslySetInnerHTML line contains 'recap'", () => {
    const src = readFileSync(new URL("../web/src/App.tsx", import.meta.url).pathname, "utf8");
    for (const line of src.split("\n")) {
      if (line.includes("dangerouslySetInnerHTML")) {
        expect(line, `found 'recap' on a dangerouslySetInnerHTML line: ${line.trim()}`).not.toContain("recap");
      }
    }
  });

});

describe("UI safety — SessionModal clipboard (SEC-5)", () => {
  const modalSrc = (): string =>
    readFileSync(new URL("../web/src/components/SessionModal.tsx", import.meta.url).pathname, "utf8");

  it("no xterm clipboard addon — OSC 52 must stay inert", () => {
    expect(modalSrc()).not.toMatch(/addon-clipboard|ClipboardAddon/);
  });
  it("no web-links addon — OSC 8 must stay inert", () => {
    expect(modalSrc()).not.toMatch(/addon-web-links|WebLinksAddon/);
  });
  it("output→input write-back paths stay disabled (SEC-5 constructor invariants)", () => {
    expect(modalSrc()).toContain("allowProposedApi: false");
    expect(modalSrc()).toContain("windowOptions: {}");
  });
  it("⌥+drag escape hatch configured for mouse-reporting TUIs", () => {
    expect(modalSrc()).toContain("macOptionClickForcesSelection: true");
  });
  it("copy-on-select guards the empty selection — a clear must not wipe the clipboard", () => {
    expect(modalSrc()).toContain("onSelectionChange");
    expect(modalSrc()).toMatch(/s\.length > 0/);
  });
});

describe("UI safety — SessionModal auto-close policy", () => {
  it("auto-closes only on code 1000 — failure codes must keep the modal open", () => {
    const src = readFileSync(new URL("../web/src/components/SessionModal.tsx", import.meta.url).pathname, "utf8");
    expect(src).toContain("closeInfo?.code !== 1000");
  });
});
