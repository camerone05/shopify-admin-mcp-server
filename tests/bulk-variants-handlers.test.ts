import { describe, it, expect, vi } from "vitest";
import {
  runBulkUpdateVariants,
  runAuditVariantCustoms,
  buildAuditVariantCustomsResult,
  type BulkUpdateVariantsParams,
  type AuditVariantCustomsParams,
} from "../src/tools/bulk-variants.js";
import type { GqlFn } from "../src/bulk.js";

interface ScanNode {
  id: string;
  sku: string | null;
  product: { id: string };
  inventoryItem: { harmonizedSystemCode: string | null; countryCodeOfOrigin: string | null };
}

function scanResponse(nodes: ScanNode[]) {
  return {
    productVariants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes,
    },
  };
}

function makeVariant(overrides: Partial<ScanNode> = {}): ScanNode {
  return {
    id: "gid://shopify/ProductVariant/1",
    sku: "SKU-1",
    product: { id: "gid://shopify/Product/1" },
    inventoryItem: { harmonizedSystemCode: null, countryCodeOfOrigin: null },
    ...overrides,
  };
}

const baseParams: BulkUpdateVariantsParams = { maxVariants: 500 };

describe("runBulkUpdateVariants", () => {
  it("dry run reports matched variants, sets dry_run true, and never calls the bulk mutation", async () => {
    const gql = vi.fn(async () => scanResponse([makeVariant()])) as unknown as GqlFn;

    const result = await runBulkUpdateVariants(
      { ...baseParams, skus: ["SKU-1"], harmonizedSystemCode: "611030", dryRun: true },
      gql
    );

    expect(result.dry_run).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.variants).toEqual([
      { variant_id: "gid://shopify/ProductVariant/1", sku: "SKU-1", product_id: "gid://shopify/Product/1" },
    ]);
    // Only selectVariants' single-page scan should have called gql — never the bulk mutation.
    expect(gql).toHaveBeenCalledTimes(1);
  });

  it("throws on a malformed harmonizedSystemCode even in dry run, before any network call", async () => {
    const gql = vi.fn(async () => scanResponse([])) as unknown as GqlFn;

    await expect(
      runBulkUpdateVariants(
        { ...baseParams, skus: ["SKU-1"], harmonizedSystemCode: "abc", dryRun: true },
        gql
      )
    ).rejects.toThrow(/not a valid HS\/HTS code/);

    expect(gql).not.toHaveBeenCalled();
  });

  it("echoes normalised values in would_set, not the caller's raw input", async () => {
    const gql = vi.fn(async () => scanResponse([makeVariant()])) as unknown as GqlFn;

    const result = await runBulkUpdateVariants(
      {
        ...baseParams,
        skus: ["SKU-1"],
        harmonizedSystemCode: "6110.30",
        countryCodeOfOrigin: "au",
        dryRun: true,
      },
      gql
    );

    expect(result.would_set).toMatchObject({
      harmonizedSystemCode: "611030",
      countryCodeOfOrigin: "AU",
    });
  });

  it("throws when weightUnit is provided without weightValue, even in dry run, before any network call", async () => {
    const gql = vi.fn(async () => scanResponse([])) as unknown as GqlFn;

    await expect(
      runBulkUpdateVariants(
        { ...baseParams, skus: ["SKU-1"], weightUnit: "GRAMS", dryRun: true },
        gql
      )
    ).rejects.toThrow(/weightUnit requires weightValue/);

    expect(gql).not.toHaveBeenCalled();
  });

  it("rejects a call with selectors but no updatable fields before any network call", async () => {
    const gql = vi.fn(async () => scanResponse([])) as unknown as GqlFn;

    await expect(
      runBulkUpdateVariants({ ...baseParams, skus: ["SKU-1"] }, gql)
    ).rejects.toThrow(/Provide at least one field to update/);

    expect(gql).not.toHaveBeenCalled();
  });

  it("returns matched: 0 without crashing when the selector matches nothing", async () => {
    const gql = vi.fn(async () => scanResponse([])) as unknown as GqlFn;

    const result = await runBulkUpdateVariants(
      { ...baseParams, skus: ["SKU-404"], harmonizedSystemCode: "611030" },
      gql
    );

    expect(result).toMatchObject({ success: true, matched: 0, updated: [], failed: [] });
  });

  it("live write reports applied with normalised values, matching what would_set previewed", async () => {
    const variant = makeVariant();
    let call = 0;
    // Call 1 is selectVariants' scan; call 2+ is the bulk update mutation.
    const gql = vi.fn(async () => {
      call++;
      if (call === 1) return scanResponse([variant]);
      return {
        productVariantsBulkUpdate: {
          productVariants: [{ id: variant.id, sku: variant.sku }],
          userErrors: [],
        },
      };
    }) as unknown as GqlFn;

    const result = await runBulkUpdateVariants(
      {
        ...baseParams,
        skus: ["SKU-1"],
        harmonizedSystemCode: "6110.30",
        countryCodeOfOrigin: "au",
        dryRun: false,
      },
      gql
    );

    expect(result.dry_run).toBe(false);
    expect(result.applied).toMatchObject({
      harmonizedSystemCode: "611030",
      countryCodeOfOrigin: "AU",
    });
  });
});

describe("runAuditVariantCustoms", () => {
  it("reports variants_total_missing uncapped while variants respects limit", async () => {
    const nodes = [
      makeVariant({ id: "gid://shopify/ProductVariant/1", sku: "A" }),
      makeVariant({ id: "gid://shopify/ProductVariant/2", sku: "B" }),
      makeVariant({ id: "gid://shopify/ProductVariant/3", sku: "C" }),
    ];
    const gql = vi.fn(async () => scanResponse(nodes)) as unknown as GqlFn;

    const params: AuditVariantCustomsParams = { includeVariants: true, limit: 1 };
    const result = await runAuditVariantCustoms(params, gql);

    expect(result.variants_total_missing).toBe(3);
    expect((result.variants as unknown[]).length).toBe(1);
  });

  it("returns an empty variants array (not undefined) when includeVariants is false", async () => {
    const nodes = [makeVariant({ id: "gid://shopify/ProductVariant/1", sku: "A" })];
    const gql = vi.fn(async () => scanResponse(nodes)) as unknown as GqlFn;

    const params: AuditVariantCustomsParams = { includeVariants: false, limit: 200 };
    const result = await runAuditVariantCustoms(params, gql);

    expect(result.variants).toEqual([]);
    expect(result.variants_total_missing).toBe(1);
  });
});

describe("buildAuditVariantCustomsResult (FINDING 1: okList instead of ok)", () => {
  it("produces valid, parseable JSON even when the missing-variant list would blow the char budget, and keeps variants_total_missing uncapped", async () => {
    // This store has 896 variants; the review's break-even for ok()+truncate()
    // cutting mid-object is around 430. 900 missing variants reproduces that.
    const nodes = Array.from({ length: 900 }, (_, i) =>
      makeVariant({ id: `gid://shopify/ProductVariant/${i}`, sku: `SKU-${i}` })
    );
    const gql = vi.fn(async () => scanResponse(nodes)) as unknown as GqlFn;

    const params: AuditVariantCustomsParams = { includeVariants: true, limit: 1000 };
    const result = await buildAuditVariantCustomsResult(params, gql);

    const text = result.content[0].text;
    expect(() => JSON.parse(text)).not.toThrow();

    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.variants_total_missing).toBe(900);
    expect(parsed.truncated).toBe(true);
    expect(parsed.returned as number).toBeLessThan(900);
    expect((parsed.variants as unknown[]).length).toBe(parsed.returned);
  });

  it("keeps a small missing list intact and untrimmed", async () => {
    const nodes = [
      makeVariant({ id: "gid://shopify/ProductVariant/1", sku: "A" }),
      makeVariant({ id: "gid://shopify/ProductVariant/2", sku: "B" }),
    ];
    const gql = vi.fn(async () => scanResponse(nodes)) as unknown as GqlFn;

    const result = await buildAuditVariantCustomsResult({ includeVariants: true, limit: 200 }, gql);
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(parsed.returned).toBe(2);
    expect(parsed.of).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.variants_total_missing).toBe(2);
  });

  it("returns an empty, valid variants array when includeVariants is false", async () => {
    const nodes = [makeVariant({ id: "gid://shopify/ProductVariant/1", sku: "A" })];
    const gql = vi.fn(async () => scanResponse(nodes)) as unknown as GqlFn;

    const result = await buildAuditVariantCustomsResult({ includeVariants: false, limit: 200 }, gql);
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(parsed.variants).toEqual([]);
    expect(parsed.returned).toBe(0);
    expect(parsed.variants_total_missing).toBe(1);
  });
});
