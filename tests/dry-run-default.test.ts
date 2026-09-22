import { describe, it, expect } from "vitest";
import { resolveDryRun } from "../src/tools/bulk-variants.js";

describe("resolveDryRun", () => {
  it("defaults to true when price is present", () => {
    expect(resolveDryRun(undefined, { price: "29.99" })).toBe(true);
  });

  it("defaults to true when compareAtPrice is present", () => {
    expect(resolveDryRun(undefined, { compareAtPrice: "39.99" })).toBe(true);
  });

  it("defaults to false for customs-only payloads", () => {
    expect(resolveDryRun(undefined, { harmonizedSystemCode: "611030" })).toBe(false);
  });

  it("defaults to false for cost-only payloads", () => {
    expect(resolveDryRun(undefined, { cost: "12.50" })).toBe(false);
  });

  it("lets an explicit false override the price default", () => {
    expect(resolveDryRun(false, { price: "29.99" })).toBe(false);
  });

  it("lets an explicit true override the non-price default", () => {
    expect(resolveDryRun(true, { harmonizedSystemCode: "611030" })).toBe(true);
  });
});
