import { describe, it, expect } from "vitest";

import { assertLoopback, isLoopbackHost } from "../server/host-guard.ts";

describe("assertLoopback", () => {
  it("allows loopback hosts", () => {
    expect(() => { assertLoopback("127.0.0.1"); }).not.toThrow();
    expect(() => { assertLoopback("localhost"); }).not.toThrow();
    expect(() => { assertLoopback("::1"); }).not.toThrow();
  });
  it("throws on a non-loopback host", () => {
    expect(() => { assertLoopback("0.0.0.0"); }).toThrow(/loopback/);
  });
});

describe("isLoopbackHost (Host-header anti-rebinding guard)", () => {
  it("accepts loopback hostnames with or without a port", () => {
    expect(isLoopbackHost("127.0.0.1:8787")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost:5173")).toBe(true); // dev Vite proxy
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]:8787")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });
  it("rejects non-loopback, malformed, and absent hosts (fail closed)", () => {
    expect(isLoopbackHost("attacker.com")).toBe(false);
    expect(isLoopbackHost("evil.com:8787")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false); // rebinding suffix trick
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
  it("is not fooled by userinfo before the host", () => {
    // http://127.0.0.1:8787@evil.com — the actual host is evil.com, not the loopback userinfo.
    expect(isLoopbackHost("127.0.0.1:8787@evil.com")).toBe(false);
  });
});
