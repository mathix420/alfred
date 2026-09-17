import { describe, expect, it } from "bun:test";
import { dedupKeyOf, isCurrentlyTrue, isLive, normalizeName, now } from "../src/memory/temporal";

describe("now", () => {
  it("returns an epoch-ms number", () => {
    const t = now();
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThan(1_700_000_000_000);
  });
});

describe("normalizeName", () => {
  it("lower-cases, trims, collapses whitespace and strips punctuation", () => {
    expect(normalizeName("  Café   del  Mar! ")).toBe("café del mar");
  });

  it("keeps unicode letters and digits", () => {
    expect(normalizeName("Projekt-42 (v2)")).toBe("projekt42 v2");
  });
});

describe("dedupKeyOf", () => {
  it("joins group, type and normalized name", () => {
    expect(dedupKeyOf("default", "person", "ada lovelace")).toBe("default|person|ada lovelace");
  });
});

describe("isLive", () => {
  it("is live until expiredAt is stamped", () => {
    expect(isLive({})).toBe(true);
    expect(isLive({ expiredAt: null })).toBe(true);
    expect(isLive({ expiredAt: 123 })).toBe(false);
  });
});

describe("isCurrentlyTrue", () => {
  it("requires the fact to be live", () => {
    expect(isCurrentlyTrue({ expiredAt: 50 }, 100)).toBe(false);
  });

  it("honours the event-time validity window", () => {
    expect(isCurrentlyTrue({}, 100)).toBe(true);
    expect(isCurrentlyTrue({ validAt: 50 }, 100)).toBe(true);
    expect(isCurrentlyTrue({ validAt: 200 }, 100)).toBe(false);
    expect(isCurrentlyTrue({ invalidAt: 150 }, 100)).toBe(true);
    expect(isCurrentlyTrue({ invalidAt: 100 }, 100)).toBe(false);
  });
});
