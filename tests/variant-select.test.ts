import { describe, it, expect, vi } from "vitest";
import { buildSelectorQuery, selectVariants } from "../src/variant-select.js";

describe("buildSelectorQuery", () => {
  it("returns null when no server-side filter applies", () => {
    expect(buildSelectorQuery({})).toBeNull();
    expect(buildSelectorQuery({ onlyMissingHsCode: true })).toBeNull();
  });

  it("ORs multiple skus together", () => {
    expect(buildSelectorQuery({ skus: ["A-1", "B-2"] })).toBe('(sku:"A-1" OR sku:"B-2")');
  });

  it("quotes skus containing spaces or quotes", () => {
    expect(buildSelectorQuery({ skus: ['ODD "1"'] })).toBe('(sku:"ODD \\"1\\"")');
  });

  it("passes a raw query through untouched", () => {
    expect(buildSelectorQuery({ query: "product_type:Socks" })).toBe("product_type:Socks");
  });

  it("ANDs a raw query with a sku list", () => {
    expect(buildSelectorQuery({ skus: ["A-1"], query: "product_type:Socks" }))
      .toBe('(sku:"A-1") AND product_type:Socks');
  });
});

describe("selectVariants", () => {
  const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
    productVariants: { nodes, pageInfo: { hasNextPage, endCursor } },
  });

  const variant = (id: string, productId: string, sku: string | null, hs: string | null, origin: string | null) => ({
    id, sku,
    product: { id: productId },
    inventoryItem: { harmonizedSystemCode: hs, countryCodeOfOrigin: origin },
  });

  it("maps variants to targets", async () => {
    const gql = vi.fn().mockResolvedValue(page([variant("v1", "p1", "S-1", "611030", "AU")]));
    const targets = await selectVariants({ query: "x" }, 500, gql);
    expect(targets).toEqual([{ variantId: "v1", productId: "p1", sku: "S-1" }]);
  });

  it("filters to variants missing an HS code when asked", async () => {
    const gql = vi.fn().mockResolvedValue(page([
      variant("v1", "p1", "S-1", "611030", "AU"),
      variant("v2", "p1", "S-2", null, "AU"),
    ]));
    const targets = await selectVariants({ onlyMissingHsCode: true }, 500, gql);
    expect(targets.map((t) => t.variantId)).toEqual(["v2"]);
  });

  it("filters to variants missing an origin when asked", async () => {
    const gql = vi.fn().mockResolvedValue(page([
      variant("v1", "p1", "S-1", "611030", "AU"),
      variant("v2", "p1", "S-2", "611030", null),
    ]));
    const targets = await selectVariants({ onlyMissingOrigin: true }, 500, gql);
    expect(targets.map((t) => t.variantId)).toEqual(["v2"]);
  });

  it("restricts to the given productIds", async () => {
    const gql = vi.fn().mockResolvedValue(page([
      variant("v1", "p1", "S-1", null, null),
      variant("v2", "p2", "S-2", null, null),
    ]));
    const targets = await selectVariants({ productIds: ["p2"] }, 500, gql);
    expect(targets.map((t) => t.variantId)).toEqual(["v2"]);
  });

  it("follows pagination", async () => {
    const gql = vi.fn()
      .mockResolvedValueOnce(page([variant("v1", "p1", null, null, null)], true, "CURSOR"))
      .mockResolvedValueOnce(page([variant("v2", "p1", null, null, null)]));
    const targets = await selectVariants({ query: "x" }, 500, gql);
    expect(targets.map((t) => t.variantId)).toEqual(["v1", "v2"]);
    expect(gql.mock.calls[1][1]).toMatchObject({ cursor: "CURSOR" });
  });

  it("refuses rather than truncating when the match exceeds maxVariants", async () => {
    const gql = vi.fn().mockResolvedValue(page([
      variant("v1", "p1", null, null, null),
      variant("v2", "p1", null, null, null),
      variant("v3", "p1", null, null, null),
    ]));
    await expect(selectVariants({ query: "x" }, 2, gql)).rejects.toThrow(/3 variants.*maxVariants is 2/);
  });

  it("rejects a selector with no criteria at all", async () => {
    const gql = vi.fn();
    await expect(selectVariants({}, 500, gql)).rejects.toThrow(/at least one selector/);
    expect(gql).not.toHaveBeenCalled();
  });
});
