# Bulk Variant Updates, Analytics & Marketing Tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bulk variant updating (HS/HTS codes, customs, pricing, identifiers), a customs coverage audit, ShopifyQL analytics, and marketing/customer event tools to the Shopify MCP server.

**Architecture:** A field-agnostic bulk engine (`src/bulk.ts`) groups variant GIDs by product, chunks at 100, and issues one `productVariantsBulkUpdate` per chunk, aggregating per-product results. Tool modules sit on top of it and own only their field semantics and selectors. Analytics and marketing are independent read-only modules with no shared engine.

**Tech Stack:** TypeScript (ES2022, Node16 modules), `@modelcontextprotocol/sdk`, `zod` v3, `axios`, `vitest` (new).

## Global Constraints

- **No git operations of any kind.** The user has a standing instruction not to interfere with git repos. Do not `git add`, `git commit`, `git checkout`, or `git stash`. Verification steps replace commit steps throughout this plan.
- Shopify Admin GraphQL API version is `2026-01`, from `API_VERSION` in `src/shopify-client.ts`. Do not change it.
- All GraphQL must be validated against the 2026-01 schema before being considered done.
- Source lives in `src/`; `tsconfig.json` sets `rootDir: ./src` and `include: ["src/**/*"]`. **Tests must live in `tests/` at the repo root**, or they will be compiled into `dist/`.
- Imports use Node16 resolution with explicit `.js` extensions (e.g. `import { ok } from "../src/shopify-client.js"`), even when the target is a `.ts` file.
- Reuse existing helpers from `src/shopify-client.ts`: `ok`, `okList`, `err`, `checkUserErrors`, `shopifyGraphQL`, `quoteQueryValue`, and the annotation constants `READ_ONLY`, `WRITE_SAFE`.
- Tool names are prefixed `shopify_`; input schemas are zod raw shapes; every handler is wrapped in `try { ... } catch (error) { return err(error); }`.
- Chunk size is **100** variants per `productVariantsBulkUpdate` call, not the documented maximum of 250.
- `maxVariants` default is **500**, and exceeding it is a hard refusal, never a silent truncation.
- `sku` must **not** be settable through the bulk tool.

---

### Task 1: Vitest setup and shared variant-field helpers

Extracts the HS/country normalisers out of `src/tools/inventory.ts` into a shared module the bulk engine can also use, and stands up the test framework the repo currently lacks.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/variant-fields.ts`
- Create: `tests/variant-fields.test.ts`
- Modify: `package.json` (add `test` script and `vitest` devDependency)
- Modify: `src/tools/inventory.ts` (delete the two local normaliser functions, import them instead)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normaliseHsCode(raw: string, field: string): string`
  - `normaliseCountryCode(raw: string, field: string): string`
  - `interface VariantFieldInput` — the 14 settable fields
  - `touchesPrice(fields: VariantFieldInput): boolean`
  - `buildVariantInput(variantId: string, fields: VariantFieldInput): Record<string, unknown>`

- [ ] **Step 1: Add vitest to the project**

Run:

```bash
npm install --save-dev vitest@^2.1.0
```

Then add the `test` script to `package.json` `scripts` (keep the existing scripts):

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Create the vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 3: Write the failing tests**

Create `tests/variant-fields.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  normaliseHsCode,
  normaliseCountryCode,
  touchesPrice,
  buildVariantInput,
} from "../src/variant-fields.js";

describe("normaliseHsCode", () => {
  it("accepts a bare 6-digit code", () => {
    expect(normaliseHsCode("611030", "hs")).toBe("611030");
  });

  it("strips dots, spaces and dashes from merchant-formatted codes", () => {
    expect(normaliseHsCode("6110.20.20", "hs")).toBe("61102020");
    expect(normaliseHsCode("6203 49 6030", "hs")).toBe("6203496030");
    expect(normaliseHsCode("6110-30", "hs")).toBe("611030");
  });

  it("rejects codes that are too short, too long, or non-numeric", () => {
    expect(() => normaliseHsCode("6110", "hs")).toThrow(/6 to 13 digits/);
    expect(() => normaliseHsCode("12345678901234", "hs")).toThrow(/6 to 13 digits/);
    expect(() => normaliseHsCode("61103X", "hs")).toThrow(/6 to 13 digits/);
  });

  it("names the offending field in the error", () => {
    expect(() => normaliseHsCode("nope", "myField")).toThrow(/myField/);
  });
});

describe("normaliseCountryCode", () => {
  it("uppercases and trims", () => {
    expect(normaliseCountryCode(" au ", "origin")).toBe("AU");
    expect(normaliseCountryCode("cn", "origin")).toBe("CN");
  });

  it("rejects anything that is not two letters", () => {
    expect(() => normaliseCountryCode("AUS", "origin")).toThrow(/2-letter/);
    expect(() => normaliseCountryCode("A1", "origin")).toThrow(/2-letter/);
    expect(() => normaliseCountryCode("", "origin")).toThrow(/2-letter/);
  });
});

describe("touchesPrice", () => {
  it("is true when price or compareAtPrice is present", () => {
    expect(touchesPrice({ price: "10.00" })).toBe(true);
    expect(touchesPrice({ compareAtPrice: "20.00" })).toBe(true);
  });

  it("is false for customs-only and cost-only payloads", () => {
    expect(touchesPrice({ harmonizedSystemCode: "611030" })).toBe(false);
    expect(touchesPrice({ cost: "12.50" })).toBe(false);
    expect(touchesPrice({})).toBe(false);
  });
});

describe("buildVariantInput", () => {
  it("puts variant-level fields at the top level", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/1", {
      price: "29.99",
      barcode: "9312345678907",
      inventoryPolicy: "DENY",
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/1",
      price: "29.99",
      barcode: "9312345678907",
      inventoryPolicy: "DENY",
    });
  });

  it("nests inventory-item fields and normalises customs values", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/2", {
      cost: "12.50",
      harmonizedSystemCode: "6110.30",
      countryCodeOfOrigin: "au",
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/2",
      inventoryItem: {
        cost: "12.50",
        harmonizedSystemCode: "611030",
        countryCodeOfOrigin: "AU",
      },
    });
  });

  it("maps weight into the measurement structure", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/3", {
      weightValue: 0.25,
      weightUnit: "KILOGRAMS",
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/3",
      inventoryItem: { measurement: { weight: { value: 0.25, unit: "KILOGRAMS" } } },
    });
  });

  it("normalises every entry in countryHarmonizedSystemCodes", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/4", {
      countryHarmonizedSystemCodes: [{ countryCode: "us", harmonizedSystemCode: "6110.30.20.20" }],
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/4",
      inventoryItem: {
        countryHarmonizedSystemCodes: [
          { countryCode: "US", harmonizedSystemCode: "6110302020" },
        ],
      },
    });
  });

  it("omits an empty inventoryItem rather than sending an empty object", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/5", { price: "1.00" });
    expect(input).not.toHaveProperty("inventoryItem");
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/variant-fields.test.ts`
Expected: FAIL — `Failed to resolve import "../src/variant-fields.js"`

- [ ] **Step 5: Write the implementation**

Create `src/variant-fields.ts`:

```ts
/**
 * Shared variant field handling for single and bulk writes.
 *
 * Shopify splits a variant's data across two input types: variant-level fields
 * live on ProductVariantsBulkInput, while cost, customs and weight live on a
 * nested InventoryItemInput. Callers should not have to care, so this module
 * takes one flat object and produces the nested shape Shopify expects.
 */

/** Weight units accepted by InventoryItemMeasurementInput. */
export type WeightUnit = "GRAMS" | "KILOGRAMS" | "OUNCES" | "POUNDS";

/** Every field the bulk tool can set. `sku` is deliberately absent — see the design doc. */
export interface VariantFieldInput {
  // Variant level
  price?: string;
  compareAtPrice?: string;
  barcode?: string;
  taxable?: boolean;
  taxCode?: string;
  inventoryPolicy?: "DENY" | "CONTINUE";
  // Inventory item level
  cost?: string;
  tracked?: boolean;
  requiresShipping?: boolean;
  harmonizedSystemCode?: string;
  countryCodeOfOrigin?: string;
  provinceCodeOfOrigin?: string;
  countryHarmonizedSystemCodes?: Array<{ countryCode: string; harmonizedSystemCode: string }>;
  weightValue?: number;
  weightUnit?: WeightUnit;
}

/**
 * Strip the dots and spaces merchants copy out of tariff schedules, then check the
 * result is a plausible HS/HTS code — 6 digits internationally, extended to 8, 10 or
 * 13 by national schedules.
 */
export function normaliseHsCode(raw: string, field: string): string {
  const digits = raw.replace(/[\s.\-]/g, "");
  if (!/^\d{6,13}$/.test(digits)) {
    throw new Error(
      `${field}: "${raw}" is not a valid HS/HTS code. Expected 6 to 13 digits ` +
      `(dots, spaces and dashes are ignored), e.g. '611020' or '6110.20.20'.`
    );
  }
  return digits;
}

/** Shopify's CountryCode enum is uppercase; accept any casing from the caller. */
export function normaliseCountryCode(raw: string, field: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(`${field}: "${raw}" is not a 2-letter ISO country code, e.g. 'AU' or 'CN'.`);
  }
  return code;
}

/** True when the payload changes storefront-visible pricing. Drives the dry-run default. */
export function touchesPrice(fields: VariantFieldInput): boolean {
  return fields.price !== undefined || fields.compareAtPrice !== undefined;
}

/** Flat caller-facing fields → the nested ProductVariantsBulkInput Shopify expects. */
export function buildVariantInput(
  variantId: string,
  fields: VariantFieldInput
): Record<string, unknown> {
  const variant: Record<string, unknown> = { id: variantId };
  const item: Record<string, unknown> = {};

  if (fields.price !== undefined) variant.price = fields.price;
  if (fields.compareAtPrice !== undefined) variant.compareAtPrice = fields.compareAtPrice;
  if (fields.barcode !== undefined) variant.barcode = fields.barcode;
  if (fields.taxable !== undefined) variant.taxable = fields.taxable;
  if (fields.taxCode !== undefined) variant.taxCode = fields.taxCode;
  if (fields.inventoryPolicy !== undefined) variant.inventoryPolicy = fields.inventoryPolicy;

  if (fields.cost !== undefined) item.cost = fields.cost;
  if (fields.tracked !== undefined) item.tracked = fields.tracked;
  if (fields.requiresShipping !== undefined) item.requiresShipping = fields.requiresShipping;
  if (fields.harmonizedSystemCode !== undefined) {
    item.harmonizedSystemCode = normaliseHsCode(fields.harmonizedSystemCode, "harmonizedSystemCode");
  }
  if (fields.countryCodeOfOrigin !== undefined) {
    item.countryCodeOfOrigin = normaliseCountryCode(fields.countryCodeOfOrigin, "countryCodeOfOrigin");
  }
  if (fields.provinceCodeOfOrigin !== undefined) {
    item.provinceCodeOfOrigin = fields.provinceCodeOfOrigin.trim().toUpperCase();
  }
  if (fields.countryHarmonizedSystemCodes !== undefined) {
    item.countryHarmonizedSystemCodes = fields.countryHarmonizedSystemCodes.map((c) => ({
      countryCode: normaliseCountryCode(c.countryCode, "countryHarmonizedSystemCodes.countryCode"),
      harmonizedSystemCode: normaliseHsCode(
        c.harmonizedSystemCode, "countryHarmonizedSystemCodes.harmonizedSystemCode"
      ),
    }));
  }
  if (fields.weightValue !== undefined) {
    item.measurement = {
      weight: { value: fields.weightValue, unit: fields.weightUnit ?? "KILOGRAMS" },
    };
  }

  if (Object.keys(item).length > 0) variant.inventoryItem = item;
  return variant;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/variant-fields.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 7: Remove the duplicated normalisers from inventory.ts**

In `src/tools/inventory.ts`, delete the local `normaliseHsCode` and `normaliseCountryCode` function definitions (they sit just above `resolveInventoryItemId` in the Helpers section), and add this import alongside the existing imports:

```ts
import { normaliseHsCode, normaliseCountryCode } from "../variant-fields.js";
```

- [ ] **Step 8: Verify nothing broke**

Run: `npx tsc --noEmit`
Expected: exit 0, no output

Run: `npx vitest run`
Expected: PASS

---

### Task 2: Bulk engine

Field-agnostic. Knows how to group, chunk, execute and aggregate — nothing about customs or pricing.

**Files:**
- Create: `src/bulk.ts`
- Create: `tests/bulk.test.ts`

**Interfaces:**
- Consumes: `buildVariantInput`, `VariantFieldInput` from `src/variant-fields.js`.
- Produces:
  - `BULK_CHUNK_SIZE: 100`
  - `interface BulkTarget { variantId: string; productId: string; sku: string | null }`
  - `interface BulkResult { success: boolean; updated: BulkUpdated[]; failed: BulkFailure[] }`
  - `groupByProduct(targets: BulkTarget[]): Map<string, BulkTarget[]>`
  - `chunk<T>(items: T[], size: number): T[][]`
  - `runBulkVariantUpdate(targets, fields, gql): Promise<BulkResult>`

- [ ] **Step 1: Write the failing tests**

Create `tests/bulk.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bulk.test.ts`
Expected: FAIL — `Failed to resolve import "../src/bulk.js"`

- [ ] **Step 3: Write the implementation**

Create `src/bulk.ts`:

```ts
/**
 * Field-agnostic bulk variant writer.
 *
 * Shopify's productVariantsBulkUpdate takes one productId per call, so a flat
 * list of variants has to be regrouped by product before it can be written.
 * This module owns that regrouping, the chunking, and the per-product result
 * aggregation — it deliberately knows nothing about WHICH fields are being set,
 * so any future bulk variant write can reuse it unchanged.
 */

import { buildVariantInput, type VariantFieldInput } from "./variant-fields.js";

/**
 * Variants per call. Below Shopify's documented max of 250 on purpose: each
 * nested inventoryItem payload adds query cost, and tripping the cost ceiling
 * surfaces as an opaque throttle rather than a clear error.
 */
export const BULK_CHUNK_SIZE = 100;

export const VARIANTS_BULK_UPDATE_MUTATION = `
  mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

export interface BulkTarget {
  variantId: string;
  productId: string;
  sku: string | null;
}

export interface BulkUpdated {
  variant_id: string;
  sku: string | null;
  product_id: string;
}

export interface BulkFailure {
  product_id: string;
  errors: string[];
}

export interface BulkResult {
  success: boolean;
  updated: BulkUpdated[];
  failed: BulkFailure[];
}

/** Injected so the engine can be tested without a network. */
export type GqlFn = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

interface BulkUpdateResponse {
  productVariantsBulkUpdate: {
    productVariants: Array<{ id: string; sku: string | null }>;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function groupByProduct(targets: BulkTarget[]): Map<string, BulkTarget[]> {
  const grouped = new Map<string, BulkTarget[]>();
  for (const t of targets) {
    const existing = grouped.get(t.productId);
    if (existing) existing.push(t);
    else grouped.set(t.productId, [t]);
  }
  return grouped;
}

/**
 * Apply the same field payload to every target.
 *
 * A failure on one product never aborts the others — partial success is normal
 * here, so every product is attempted and the caller is told exactly which ones
 * landed and which did not.
 */
export async function runBulkVariantUpdate(
  targets: BulkTarget[],
  fields: VariantFieldInput,
  gql: GqlFn
): Promise<BulkResult> {
  const updated: BulkUpdated[] = [];
  const failed: BulkFailure[] = [];

  for (const [productId, productTargets] of groupByProduct(targets)) {
    for (const batch of chunk(productTargets, BULK_CHUNK_SIZE)) {
      try {
        const data = await gql<BulkUpdateResponse>(VARIANTS_BULK_UPDATE_MUTATION, {
          productId,
          variants: batch.map((t) => buildVariantInput(t.variantId, fields)),
        });
        const errors = data.productVariantsBulkUpdate.userErrors;
        if (errors.length > 0) {
          failed.push({ product_id: productId, errors: errors.map((e) => e.message) });
          continue;
        }
        for (const t of batch) {
          updated.push({ variant_id: t.variantId, sku: t.sku, product_id: productId });
        }
      } catch (error) {
        failed.push({
          product_id: productId,
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
    }
  }

  return { success: failed.length === 0, updated, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bulk.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: exit 0

---

### Task 3: Variant selection

Turns the caller's selectors into a concrete list of `BulkTarget`s, and enforces `maxVariants`.

**Files:**
- Create: `src/variant-select.ts`
- Create: `tests/variant-select.test.ts`

**Interfaces:**
- Consumes: `BulkTarget` from `src/bulk.js`; `quoteQueryValue` from `src/shopify-client.js`.
- Produces:
  - `interface VariantSelector { skus?: string[]; productIds?: string[]; query?: string; onlyMissingHsCode?: boolean; onlyMissingOrigin?: boolean }`
  - `buildSelectorQuery(selector: VariantSelector): string | null`
  - `selectVariants(selector, maxVariants, gql): Promise<BulkTarget[]>`

- [ ] **Step 1: Write the failing tests**

Create `tests/variant-select.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/variant-select.test.ts`
Expected: FAIL — `Failed to resolve import "../src/variant-select.js"`

- [ ] **Step 3: Write the implementation**

Create `src/variant-select.ts`:

```ts
/**
 * Selector → concrete variant list.
 *
 * Some selectors (skus, query) can be pushed into Shopify's search index; the
 * "missing customs data" ones cannot, so they are applied client-side after the
 * scan. Everything is combined with AND.
 */

import { quoteQueryValue } from "./shopify-client.js";
import type { BulkTarget, GqlFn } from "./bulk.js";

export interface VariantSelector {
  skus?: string[];
  productIds?: string[];
  query?: string;
  onlyMissingHsCode?: boolean;
  onlyMissingOrigin?: boolean;
}

export const VARIANT_SCAN_QUERY = `
  query ScanVariants($cursor: String, $query: String) {
    productVariants(first: 250, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id sku
        product { id }
        inventoryItem { harmonizedSystemCode countryCodeOfOrigin }
      }
    }
  }
`;

interface ScanNode {
  id: string;
  sku: string | null;
  product: { id: string };
  inventoryItem: { harmonizedSystemCode: string | null; countryCodeOfOrigin: string | null };
}

interface ScanResponse {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ScanNode[];
  };
}

/** Build the server-side portion of the selector, or null if none applies. */
export function buildSelectorQuery(selector: VariantSelector): string | null {
  const parts: string[] = [];
  if (selector.skus?.length) {
    parts.push(`(${selector.skus.map((s) => `sku:${quoteQueryValue(s)}`).join(" OR ")})`);
  }
  if (selector.query) parts.push(selector.query);
  return parts.length > 0 ? parts.join(" AND ") : null;
}

function hasAnySelector(selector: VariantSelector): boolean {
  return Boolean(
    selector.skus?.length ||
    selector.productIds?.length ||
    selector.query ||
    selector.onlyMissingHsCode ||
    selector.onlyMissingOrigin
  );
}

export async function selectVariants(
  selector: VariantSelector,
  maxVariants: number,
  gql: GqlFn
): Promise<BulkTarget[]> {
  if (!hasAnySelector(selector)) {
    throw new Error(
      "Provide at least one selector: skus, productIds, query, onlyMissingHsCode or onlyMissingOrigin."
    );
  }

  const query = buildSelectorQuery(selector);
  const productIds = selector.productIds?.length ? new Set(selector.productIds) : null;
  const targets: BulkTarget[] = [];
  let cursor: string | null = null;

  do {
    const data: ScanResponse = await gql<ScanResponse>(VARIANT_SCAN_QUERY, { cursor, query });
    const conn = data.productVariants;
    for (const node of conn.nodes) {
      if (productIds && !productIds.has(node.product.id)) continue;
      if (selector.onlyMissingHsCode && node.inventoryItem.harmonizedSystemCode) continue;
      if (selector.onlyMissingOrigin && node.inventoryItem.countryCodeOfOrigin) continue;
      targets.push({ variantId: node.id, productId: node.product.id, sku: node.sku });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  if (targets.length > maxVariants) {
    throw new Error(
      `Selector matched ${targets.length} variants but maxVariants is ${maxVariants}. ` +
      `Narrow the selector, or raise maxVariants deliberately if you mean to update them all.`
    );
  }

  return targets;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/variant-select.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: exit 0

---

### Task 4: Bulk variant tools

The two user-facing tools. This is where the computed dry-run default lives.

**Files:**
- Create: `src/tools/bulk-variants.ts`
- Create: `tests/dry-run-default.test.ts`

**Interfaces:**
- Consumes: `selectVariants`, `VariantSelector`; `runBulkVariantUpdate`, `BulkTarget`; `touchesPrice`, `VariantFieldInput`.
- Produces: `registerBulkVariantTools(server: McpServer): void`, and `resolveDryRun(explicit: boolean | undefined, fields: VariantFieldInput): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/dry-run-default.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/dry-run-default.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tools/bulk-variants.js"`

- [ ] **Step 3: Write the implementation**

Create `src/tools/bulk-variants.ts`:

```ts
/**
 * Bulk variant writes and customs coverage reporting.
 *
 * Scopes used: read_products, write_products, read_inventory.
 *
 * One tool writes any of the 14 supported variant fields across a selected set
 * of variants; the other reports which variants are missing customs data so a
 * backfill can be aimed before it is fired.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, ok, err, READ_ONLY, WRITE_SAFE } from "../shopify-client.js";
import { runBulkVariantUpdate, type GqlFn } from "../bulk.js";
import { selectVariants, VARIANT_SCAN_QUERY, type VariantSelector } from "../variant-select.js";
import { touchesPrice, type VariantFieldInput } from "../variant-fields.js";

const gql: GqlFn = shopifyGraphQL;

/**
 * Dry run defaults to ON when the payload changes storefront pricing and OFF
 * otherwise. A wrong HS code is a correctable paperwork problem; a wrong price
 * is live and charging customers. The rule reads only the current payload, so
 * it stays correct under MCP's stateless request model.
 */
export function resolveDryRun(explicit: boolean | undefined, fields: VariantFieldInput): boolean {
  if (explicit !== undefined) return explicit;
  return touchesPrice(fields);
}

const SELECTOR_SHAPE = {
  skus: z.array(z.string()).optional().describe("Exact variant SKUs"),
  productIds: z.array(z.string()).optional().describe("Product GIDs — targets every variant of each"),
  query: z.string().optional().describe("Shopify variant search, e.g. 'product_type:Socks'"),
  onlyMissingHsCode: z.boolean().optional().describe("Restrict to variants with no HS code"),
  onlyMissingOrigin: z.boolean().optional().describe("Restrict to variants with no country of origin"),
};

export function registerBulkVariantTools(server: McpServer): void {
  server.registerTool(
    "shopify_bulk_update_variants",
    {
      title: "Bulk Update Variants",
      description: `Apply the same field changes to many variants in one go — customs data, cost,
pricing, identifiers and shipping weight.

Select the variants with any combination of skus, productIds, query, onlyMissingHsCode and
onlyMissingOrigin (combined with AND). At least one selector is required.

The common customs backfill is:
  onlyMissingHsCode: true, harmonizedSystemCode: '611030', countryCodeOfOrigin: 'AU'

dryRun defaults to TRUE when price or compareAtPrice is set, and FALSE otherwise — so pricing
changes require an explicit dryRun: false, while customs and cost writes apply immediately.
A dry run reports exactly which variants would change and writes nothing.

maxVariants (default 500) is a hard refusal, not a truncation: if the selector matches more,
nothing is written and you are told the match count.

SKU cannot be changed here — bulk-rewriting SKUs would break the selectors used to address
variants. Use shopify_update_inventory_item for single-SKU changes.`,
      inputSchema: {
        ...SELECTOR_SHAPE,
        price: z.string().optional().describe("Price e.g. '29.99'"),
        compareAtPrice: z.string().optional().describe("Compare-at price e.g. '39.99'"),
        barcode: z.string().optional().describe("Barcode / GTIN"),
        taxable: z.boolean().optional(),
        taxCode: z.string().optional(),
        inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional()
          .describe("Whether to keep selling when out of stock"),
        cost: z.string().optional().describe("Unit cost e.g. '12.50'"),
        tracked: z.boolean().optional().describe("Whether Shopify tracks stock for this SKU"),
        requiresShipping: z.boolean().optional().describe("false for digital/service items"),
        harmonizedSystemCode: z.string().optional()
          .describe("HS/HTS code, 6-13 digits e.g. '611030' or '6110.30'"),
        countryCodeOfOrigin: z.string().optional().describe("2-letter ISO country code e.g. 'AU'"),
        provinceCodeOfOrigin: z.string().optional().describe("Province/state code e.g. 'BC'"),
        countryHarmonizedSystemCodes: z.array(z.object({
          countryCode: z.string(),
          harmonizedSystemCode: z.string(),
        })).optional().describe("Destination-specific HTS overrides — replaces the existing list"),
        weightValue: z.number().optional().describe("Shipping weight, e.g. 0.25"),
        weightUnit: z.enum(["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"]).optional(),
        dryRun: z.boolean().optional()
          .describe("Preview without writing. Defaults true when price fields are set."),
        maxVariants: z.number().int().min(1).max(5000).default(500)
          .describe("Refuse if the selector matches more than this"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const {
          skus, productIds, query, onlyMissingHsCode, onlyMissingOrigin,
          dryRun, maxVariants, ...fields
        } = params;

        const selector: VariantSelector = {
          skus, productIds, query, onlyMissingHsCode, onlyMissingOrigin,
        };
        const fieldInput = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        ) as VariantFieldInput;

        if (Object.keys(fieldInput).length === 0) {
          throw new Error("Provide at least one field to update");
        }

        const targets = await selectVariants(selector, maxVariants, gql);
        const isDryRun = resolveDryRun(dryRun, fieldInput);

        if (targets.length === 0) {
          return ok({ success: true, matched: 0, dry_run: isDryRun, updated: [], failed: [] });
        }

        if (isDryRun) {
          return ok({
            success: true,
            dry_run: true,
            matched: targets.length,
            would_set: fieldInput,
            variants: targets.map((t) => ({
              variant_id: t.variantId, sku: t.sku, product_id: t.productId,
            })),
            note: "Nothing was written. Pass dryRun: false to apply these changes.",
          });
        }

        const result = await runBulkVariantUpdate(targets, fieldInput, gql);
        return ok({
          ...result,
          dry_run: false,
          matched: targets.length,
          applied: fieldInput,
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_audit_variant_customs",
    {
      title: "Audit Variant Customs Coverage",
      description: `Report which variants are missing customs data — the HS/HTS code and country of
origin Shopify needs before it will generate international shipping labels.

Returns totals, the distinct HS codes already in use with their variant counts, and the list of
variants missing data. Use this to aim a backfill before running shopify_bulk_update_variants.

Read-only — it never writes.`,
      inputSchema: {
        includeVariants: z.boolean().default(true)
          .describe("Include the per-variant list of what is missing"),
        limit: z.number().int().min(1).max(1000).default(200)
          .describe("Cap on listed variants; totals always cover the whole catalogue"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        interface ScanNode {
          id: string; sku: string | null;
          product: { id: string };
          inventoryItem: { harmonizedSystemCode: string | null; countryCodeOfOrigin: string | null };
        }
        interface ScanResponse {
          productVariants: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: ScanNode[];
          };
        }

        let cursor: string | null = null;
        let total = 0;
        const missing: Array<Record<string, unknown>> = [];
        const codeCounts = new Map<string, number>();

        do {
          const data: ScanResponse = await gql<ScanResponse>(VARIANT_SCAN_QUERY, { cursor, query: null });
          const conn = data.productVariants;
          for (const node of conn.nodes) {
            total++;
            const hs = node.inventoryItem.harmonizedSystemCode;
            const origin = node.inventoryItem.countryCodeOfOrigin;
            if (hs) codeCounts.set(hs, (codeCounts.get(hs) ?? 0) + 1);
            if (!hs || !origin) {
              missing.push({
                variant_id: node.id,
                sku: node.sku,
                product_id: node.product.id,
                missing_hs_code: !hs,
                missing_origin: !origin,
              });
            }
          }
          cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
        } while (cursor);

        const missingHs = missing.filter((m) => m.missing_hs_code).length;
        const missingOrigin = missing.filter((m) => m.missing_origin).length;

        return ok({
          total_variants: total,
          missing_hs_code: missingHs,
          missing_origin: missingOrigin,
          complete: total - missing.length,
          hs_codes_in_use: [...codeCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([code, count]) => ({ code, variants: count })),
          variants: params.includeVariants ? missing.slice(0, params.limit) : undefined,
          variants_listed: params.includeVariants ? Math.min(missing.length, params.limit) : 0,
          variants_total_missing: missing.length,
        });
      } catch (error) { return err(error); }
    }
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dry-run-default.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: exit 0

---

### Task 5: Analytics (ShopifyQL)

**Files:**
- Create: `src/tools/analytics.ts`
- Create: `tests/analytics.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL`, `ok`, `err`, `READ_ONLY`.
- Produces: `registerAnalyticsTools(server: McpServer): void`, and `formatShopifyqlResponse(response: ShopifyqlResponse): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/analytics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatShopifyqlResponse } from "../src/tools/analytics.js";

describe("formatShopifyqlResponse", () => {
  it("throws when parseErrors is non-empty, rather than returning empty data", () => {
    expect(() =>
      formatShopifyqlResponse({
        shopifyqlQuery: { tableData: null, parseErrors: ["Unexpected token 'SHOWW'"] },
      })
    ).toThrow(/Unexpected token 'SHOWW'/);
  });

  it("includes every parse error in the message", () => {
    expect(() =>
      formatShopifyqlResponse({
        shopifyqlQuery: { tableData: null, parseErrors: ["first problem", "second problem"] },
      })
    ).toThrow(/first problem.*second problem/s);
  });

  it("returns columns and rows on success", () => {
    const result = formatShopifyqlResponse({
      shopifyqlQuery: {
        parseErrors: [],
        tableData: {
          columns: [
            { name: "month", dataType: "MONTH_TIMESTAMP", displayName: "Month" },
            { name: "total_sales", dataType: "MONEY", displayName: "Total sales" },
          ],
          rows: [{ month: "2026-06-01", total_sales: "70853.53" }],
        },
      },
    });
    expect(result).toEqual({
      columns: [
        { name: "month", type: "MONTH_TIMESTAMP", label: "Month" },
        { name: "total_sales", type: "MONEY", label: "Total sales" },
      ],
      rows: [{ month: "2026-06-01", total_sales: "70853.53" }],
      row_count: 1,
    });
  });

  it("treats a null tableData with no parse errors as an empty result", () => {
    const result = formatShopifyqlResponse({
      shopifyqlQuery: { tableData: null, parseErrors: [] },
    });
    expect(result).toEqual({ columns: [], rows: [], row_count: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/analytics.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tools/analytics.js"`

- [ ] **Step 3: Write the implementation**

Create `src/tools/analytics.ts`:

```ts
/**
 * ShopifyQL analytics.
 *
 * Scopes used: read_reports (plus Level 2 protected customer data access).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, ok, err, READ_ONLY } from "../shopify-client.js";

export const SHOPIFYQL_QUERY = `
  query RunShopifyql($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData {
        columns { name dataType displayName }
        rows
      }
      parseErrors
    }
  }
`;

export interface ShopifyqlResponse {
  shopifyqlQuery: {
    parseErrors: string[];
    tableData: {
      columns: Array<{ name: string; dataType: string; displayName: string }>;
      rows: Array<Record<string, unknown>>;
    } | null;
  };
}

/**
 * A malformed ShopifyQL query returns HTTP 200 with parseErrors populated and
 * tableData null. Passing that through verbatim reads as "the store has no
 * sales", so parse errors are promoted to a thrown error instead.
 */
export function formatShopifyqlResponse(response: ShopifyqlResponse): Record<string, unknown> {
  const { parseErrors, tableData } = response.shopifyqlQuery;

  if (parseErrors && parseErrors.length > 0) {
    throw new Error(`ShopifyQL could not parse the query: ${parseErrors.join("; ")}`);
  }
  if (!tableData) {
    return { columns: [], rows: [], row_count: 0 };
  }

  return {
    columns: tableData.columns.map((c) => ({
      name: c.name, type: c.dataType, label: c.displayName,
    })),
    rows: tableData.rows,
    row_count: tableData.rows.length,
  };
}

export function registerAnalyticsTools(server: McpServer): void {
  server.registerTool(
    "shopify_analytics_query",
    {
      title: "Query Store Analytics (ShopifyQL)",
      description: `Run a ShopifyQL query against the store's analytics and get back a table.

ShopifyQL shape: FROM <dataset> SHOW <metrics> [GROUP BY <dimension>] [SINCE <range>] [UNTIL <range>]
[ORDER BY <column>] [LIMIT n]

Datasets include sales, orders, products, customers.

Examples:
  FROM sales SHOW total_sales GROUP BY month SINCE -12m ORDER BY month
  FROM sales SHOW total_sales, orders GROUP BY product_title SINCE -30d ORDER BY total_sales DESC LIMIT 10
  FROM orders SHOW average_order_value SINCE -90d

A syntax error is reported as an error, not as an empty table — an empty result genuinely means
no matching data.`,
      inputSchema: {
        query: z.string().min(1).describe("ShopifyQL query, e.g. 'FROM sales SHOW total_sales SINCE -30d'"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<ShopifyqlResponse>(SHOPIFYQL_QUERY, { query: params.query });
        return ok({ query: params.query, ...formatShopifyqlResponse(data) });
      } catch (error) { return err(error); }
    }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/analytics.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Validate the GraphQL against the live schema**

Use the Shopify dev MCP `validate_graphql_codeblocks` tool with `api: "admin"`, `version: "2026-01"` and the contents of `SHOPIFYQL_QUERY`.
Expected: VALID.

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit`
Expected: exit 0

---

### Task 6: Marketing and customer events

Note for the implementer: on the current store `marketingEvents` returns 0 records and customer
events are near-empty. That is expected and is not a bug — these tools exist so they work the day
data appears. Do not "fix" an empty result.

**Files:**
- Create: `src/tools/marketing.ts`
- Create: `tests/marketing.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL`, `okList`, `ok`, `err`, `READ_ONLY`.
- Produces: `registerMarketingTools(server: McpServer): void`, and `formatMarketingEvent(node: MarketingEventNode): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/marketing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatMarketingEvent } from "../src/tools/marketing.js";

describe("formatMarketingEvent", () => {
  it("flattens an event into snake_case output", () => {
    const result = formatMarketingEvent({
      id: "gid://shopify/MarketingEvent/1",
      type: "AD",
      utmSource: "facebook",
      utmMedium: "cpc",
      utmCampaign: "spring",
      sourceAndMedium: "facebook / cpc",
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: null,
    });
    expect(result).toEqual({
      id: "gid://shopify/MarketingEvent/1",
      type: "AD",
      source_and_medium: "facebook / cpc",
      utm: { source: "facebook", medium: "cpc", campaign: "spring" },
      started_at: "2026-06-01T00:00:00Z",
      ended_at: null,
    });
  });

  it("keeps nulls rather than inventing defaults", () => {
    const result = formatMarketingEvent({
      id: "gid://shopify/MarketingEvent/2",
      type: "POST",
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      sourceAndMedium: null,
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: null,
    });
    expect(result.utm).toEqual({ source: null, medium: null, campaign: null });
    expect(result.source_and_medium).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/marketing.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tools/marketing.js"`

- [ ] **Step 3: Write the implementation**

Create `src/tools/marketing.ts`:

```ts
/**
 * Marketing events and customer activity timelines.
 *
 * Scopes used: read_marketing_events, read_customers.
 *
 * Both surfaces are frequently empty on stores without a connected marketing
 * integration. An empty result is a valid answer, not an error.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, okList, err, READ_ONLY } from "../shopify-client.js";

export const MARKETING_EVENTS_QUERY = `
  query ListMarketingEvents($first: Int!, $cursor: String) {
    marketingEvents(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type utmSource utmMedium utmCampaign sourceAndMedium startedAt endedAt
      }
    }
  }
`;

export const CUSTOMER_EVENTS_QUERY = `
  query CustomerEvents($id: ID!, $first: Int!) {
    customer(id: $id) {
      id displayName
      events(first: $first, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id message createdAt appTitle attributeToUser }
      }
    }
  }
`;

export interface MarketingEventNode {
  id: string;
  type: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  sourceAndMedium: string | null;
  startedAt: string;
  endedAt: string | null;
}

export function formatMarketingEvent(node: MarketingEventNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    source_and_medium: node.sourceAndMedium,
    utm: { source: node.utmSource, medium: node.utmMedium, campaign: node.utmCampaign },
    started_at: node.startedAt,
    ended_at: node.endedAt,
  };
}

export function registerMarketingTools(server: McpServer): void {
  server.registerTool(
    "shopify_list_marketing_events",
    {
      title: "List Marketing Events",
      description: `Marketing events recorded against the store — ad campaigns, posts and other
attributed activity, with their UTM parameters and run dates.

Only populated when a marketing app or integration publishes events to Shopify. An empty list
means no such integration is connected, not that the query failed.`,
      inputSchema: {
        limit: z.number().int().min(1).max(250).default(50),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          marketingEvents: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: MarketingEventNode[];
          };
        }>(MARKETING_EVENTS_QUERY, { first: params.limit, cursor: null });

        return okList("marketing_events", data.marketingEvents.nodes.map(formatMarketingEvent), {
          pageInfo: data.marketingEvents.pageInfo,
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_customer_events",
    {
      title: "Get Customer Activity Timeline",
      description: `The activity timeline for one customer — the same events Shopify shows on the
customer's admin page, newest first.

Many customers have no recorded events; an empty list is a valid answer.`,
      inputSchema: {
        customerId: z.string().min(1).describe("Customer GID e.g. gid://shopify/Customer/123"),
        limit: z.number().int().min(1).max(250).default(50),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          customer: {
            id: string;
            displayName: string;
            events: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<Record<string, unknown>>;
            };
          } | null;
        }>(CUSTOMER_EVENTS_QUERY, { id: params.customerId, first: params.limit });

        if (!data.customer) throw new Error(`Customer ${params.customerId} not found`);

        return okList("events", data.customer.events.nodes, {
          customer: { id: data.customer.id, name: data.customer.displayName },
          pageInfo: data.customer.events.pageInfo,
        });
      } catch (error) { return err(error); }
    }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/marketing.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Validate the GraphQL against the live schema**

Use the Shopify dev MCP `validate_graphql_codeblocks` tool with `api: "admin"`, `version: "2026-01"` and the contents of `MARKETING_EVENTS_QUERY` and `CUSTOMER_EVENTS_QUERY`.
Expected: VALID for both.

- [ ] **Step 6: Verify types**

Run: `npx tsc --noEmit`
Expected: exit 0

---

### Task 7: Registration, docs and build

**Files:**
- Modify: `src/index.ts` (imports, registration calls, scope comment)
- Modify: `README.md` (tool tables)
- Modify: `package.json` (description tool count)

**Interfaces:**
- Consumes: `registerBulkVariantTools`, `registerAnalyticsTools`, `registerMarketingTools`.
- Produces: nothing.

- [ ] **Step 1: Register the new modules**

In `src/index.ts`, add these imports after the existing tool imports:

```ts
import { registerBulkVariantTools } from "./tools/bulk-variants.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerMarketingTools } from "./tools/marketing.js";
```

And add these registration calls after `registerCommerceTools(server);`:

```ts
registerBulkVariantTools(server); // bulk variant field writes, customs coverage audit
registerAnalyticsTools(server);   // ShopifyQL
registerMarketingTools(server);   // marketing events, customer activity timelines
```

- [ ] **Step 2: Update the README tool tables**

In `README.md`, add a new section after the inventory table:

```markdown
### Bulk variant updates

| Tool | Scope | What it does |
|---|---|---|
| `shopify_bulk_update_variants` | `write_products` | Apply customs, cost, pricing, identifier and weight changes to many variants at once |
| `shopify_audit_variant_customs` | `read_products` | Report which variants are missing HS codes or country of origin |

Select variants with `skus`, `productIds`, `query`, `onlyMissingHsCode` or `onlyMissingOrigin`,
combined with AND. The common customs backfill is one call:

    onlyMissingHsCode: true, harmonizedSystemCode: "611030", countryCodeOfOrigin: "AU"

`dryRun` defaults to **true** when `price` or `compareAtPrice` is set and **false** otherwise, so
pricing changes need an explicit `dryRun: false`. `maxVariants` (default 500) refuses rather than
truncating. `sku` cannot be changed in bulk.

### Analytics & marketing

| Tool | Scope | What it does |
|---|---|---|
| `shopify_analytics_query` | `read_reports` | Run a ShopifyQL query and get a table back |
| `shopify_list_marketing_events` | `read_marketing_events` | Campaign/post events with UTM parameters |
| `shopify_get_customer_events` | `read_customers` | One customer's activity timeline |

Marketing events are only populated when a marketing integration publishes to Shopify; an empty
list means none is connected.
```

- [ ] **Step 3: Update the package description**

In `package.json`, change the tool count in `description` from `48 scope-aligned tools` to
`53 scope-aligned tools`, and append `, bulk variant updates, analytics` before the closing quote.

- [ ] **Step 4: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS, 48 tests across 6 files (13 + 11 + 12 + 6 + 4 + 2)

- [ ] **Step 5: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: exit 0

Run: `npm run build`
Expected: exit 0, `dist/tools/bulk-variants.js`, `dist/tools/analytics.js`, `dist/tools/marketing.js` and `dist/bulk.js` all present

- [ ] **Step 6: Confirm tests were not compiled into dist**

Run: `ls dist`
Expected: no `tests` directory, no `*.test.js` anywhere under `dist/`

- [ ] **Step 7: Smoke-test the server starts**

Use the **Bash** tool for this step, not PowerShell — the inline env-var prefix and `/dev/null` are POSIX syntax.

Run: `SHOPIFY_STORE_DOMAIN=x.myshopify.com SHOPIFY_ACCESS_TOKEN=dummy node dist/index.js < /dev/null`
Expected: prints the three startup lines to stderr, then exits when stdin closes. It must not throw a registration error. A registration error here means two tools share a name.

---

## Post-implementation note

The running MCP server holds the old `dist/` in memory. It must be restarted before the new tools
appear to any client.

Per the standing instruction, no git operations were performed. The working tree is left dirty for
the user to review and commit themselves.
