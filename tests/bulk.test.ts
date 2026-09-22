import { describe, it, expect, vi } from "vitest";
import {
  groupByProduct,
  chunk,
  runBulkVariantUpdate,
  BULK_CHUNK_SIZE,
  type BulkTarget,
} from "../src/bulk.js";

const target = (variantId: string, productId: string, sku: string | null = null): BulkTarget =>
  ({ variantId, productId, sku });

describe("chunk", () => {
  it("splits into equal parts and keeps the remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when the list is smaller than the size", () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
  });

  it("returns nothing for an empty list", () => {
    expect(chunk([], 100)).toEqual([]);
  });
});

describe("groupByProduct", () => {
  it("groups variants under their product", () => {
    const grouped = groupByProduct([
      target("v1", "p1"), target("v2", "p1"), target("v3", "p2"),
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get("p1")!.map((t) => t.variantId)).toEqual(["v1", "v2"]);
    expect(grouped.get("p2")!.map((t) => t.variantId)).toEqual(["v3"]);
  });
});

describe("runBulkVariantUpdate", () => {
  const okResponse = {
    productVariantsBulkUpdate: { productVariants: [], userErrors: [] },
  };

  it("issues one call per product", async () => {
    const gql = vi.fn().mockResolvedValue(okResponse);
    await runBulkVariantUpdate(
      [target("v1", "p1"), target("v2", "p1"), target("v3", "p2")],
      { harmonizedSystemCode: "611030" },
      gql
    );
    expect(gql).toHaveBeenCalledTimes(2);
  });

  it("splits a product with more than BULK_CHUNK_SIZE variants across calls", async () => {
    const gql = vi.fn().mockResolvedValue(okResponse);
    const many = Array.from({ length: BULK_CHUNK_SIZE + 1 }, (_, i) => target(`v${i}`, "p1"));
    await runBulkVariantUpdate(many, { tracked: true }, gql);
    expect(gql).toHaveBeenCalledTimes(2);
  });

  it("passes productId and the built variant inputs as variables", async () => {
    const gql = vi.fn().mockResolvedValue(okResponse);
    await runBulkVariantUpdate([target("v1", "p1")], { cost: "12.50" }, gql);
    expect(gql.mock.calls[0][1]).toEqual({
      productId: "p1",
      variants: [{ id: "v1", inventoryItem: { cost: "12.50" } }],
    });
  });

  it("reports every targeted variant as updated on success", async () => {
    const gql = vi.fn().mockResolvedValue(okResponse);
    const result = await runBulkVariantUpdate(
      [target("v1", "p1", "SKU-1")], { tracked: true }, gql
    );
    expect(result.success).toBe(true);
    expect(result.updated).toEqual([
      { variant_id: "v1", sku: "SKU-1", product_id: "p1" },
    ]);
    expect(result.failed).toEqual([]);
  });

  it("records userErrors as a failure and sets success false", async () => {
    const gql = vi.fn().mockResolvedValue({
      productVariantsBulkUpdate: {
        productVariants: [],
        userErrors: [{ field: ["price"], message: "Price must be positive" }],
      },
    });
    const result = await runBulkVariantUpdate([target("v1", "p1")], { price: "-1" }, gql);
    expect(result.success).toBe(false);
    expect(result.failed).toEqual([
      { product_id: "p1", errors: ["Price must be positive"] },
    ]);
    expect(result.updated).toEqual([]);
  });

  it("records a thrown error as a failure without aborting other products", async () => {
    const gql = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(okResponse);
    const result = await runBulkVariantUpdate(
      [target("v1", "p1"), target("v2", "p2")], { tracked: true }, gql
    );
    expect(result.success).toBe(false);
    expect(result.failed).toEqual([{ product_id: "p1", errors: ["network down"] }]);
    expect(result.updated).toEqual([{ variant_id: "v2", sku: null, product_id: "p2" }]);
  });

  it("succeeds trivially when there is nothing to do", async () => {
    const gql = vi.fn();
    const result = await runBulkVariantUpdate([], { tracked: true }, gql);
    expect(result.success).toBe(true);
    expect(gql).not.toHaveBeenCalled();
  });
});
