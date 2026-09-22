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
import { shopifyGraphQL, ok, okList, err, READ_ONLY, WRITE_SAFE } from "../shopify-client.js";
import { runBulkVariantUpdate, type GqlFn } from "../bulk.js";
import {
  selectVariants, VARIANT_SCAN_QUERY, type VariantSelector, type ScanResponse,
} from "../variant-select.js";
import { touchesPrice, buildVariantInput, type VariantFieldInput } from "../variant-fields.js";

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

/**
 * Validate a field payload the same way the live write does, and return the
 * normalised values for the fields buildVariantInput normalises (HS codes,
 * country/province codes). Called against a placeholder variant id purely
 * for validation/normalisation — nothing here is sent to Shopify, and
 * buildVariantInput itself is unchanged and still called normally by
 * runBulkVariantUpdate on the live-write path.
 *
 * This makes a dry run reject the same malformed input the live write would
 * reject, instead of reporting a false "would succeed" and only failing once
 * dryRun: false is passed. It also lets the dry-run preview show what would
 * actually be written rather than echoing the caller's raw strings.
 */
function validateAndNormalise(fields: VariantFieldInput): VariantFieldInput {
  const built = buildVariantInput("gid://shopify/ProductVariant/0", fields);
  const item = (built.inventoryItem ?? {}) as Record<string, unknown>;
  const normalised: VariantFieldInput = { ...fields };
  if (typeof item.harmonizedSystemCode === "string") {
    normalised.harmonizedSystemCode = item.harmonizedSystemCode;
  }
  if (typeof item.countryCodeOfOrigin === "string") {
    normalised.countryCodeOfOrigin = item.countryCodeOfOrigin;
  }
  if (typeof item.provinceCodeOfOrigin === "string") {
    normalised.provinceCodeOfOrigin = item.provinceCodeOfOrigin;
  }
  if (Array.isArray(item.countryHarmonizedSystemCodes)) {
    normalised.countryHarmonizedSystemCodes =
      item.countryHarmonizedSystemCodes as VariantFieldInput["countryHarmonizedSystemCodes"];
  }
  return normalised;
}

const SELECTOR_SHAPE = {
  skus: z.array(z.string()).optional().describe("Exact variant SKUs"),
  productIds: z.array(z.string()).optional().describe("Product GIDs — targets every variant of each"),
  query: z.string().optional().describe("Shopify variant search, e.g. 'product_type:Socks'"),
  onlyMissingHsCode: z.boolean().optional().describe("Restrict to variants with no HS code"),
  onlyMissingOrigin: z.boolean().optional().describe("Restrict to variants with no country of origin"),
};

/** Params for {@link runBulkUpdateVariants} — mirrors shopify_bulk_update_variants' inputSchema. */
export interface BulkUpdateVariantsParams extends VariantSelector, VariantFieldInput {
  dryRun?: boolean;
  maxVariants: number;
}

/**
 * Core logic behind shopify_bulk_update_variants, extracted so it can be unit
 * tested with an injected gql without going through the MCP server. Returns
 * the plain result payload; the registered tool wraps it with ok()/err().
 */
export async function runBulkUpdateVariants(
  params: BulkUpdateVariantsParams,
  gql: GqlFn
): Promise<Record<string, unknown>> {
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

  // Validate (and capture normalised values) before doing anything else, so a
  // dry run rejects malformed input exactly like the live write does, rather
  // than reporting success on a payload that would fail once dryRun: false.
  const normalisedFields = validateAndNormalise(fieldInput);

  const targets = await selectVariants(selector, maxVariants, gql);
  const isDryRun = resolveDryRun(dryRun, fieldInput);

  if (targets.length === 0) {
    return { success: true, matched: 0, dry_run: isDryRun, updated: [], failed: [] };
  }

  if (isDryRun) {
    return {
      success: true,
      dry_run: true,
      matched: targets.length,
      would_set: normalisedFields,
      variants: targets.map((t) => ({
        variant_id: t.variantId, sku: t.sku, product_id: t.productId,
      })),
      note: "Nothing was written. Pass dryRun: false to apply these changes.",
    };
  }

  const result = await runBulkVariantUpdate(targets, fieldInput, gql);
  return {
    ...result,
    dry_run: false,
    matched: targets.length,
    applied: normalisedFields,
  };
}

/** Params for {@link runAuditVariantCustoms} — mirrors shopify_audit_variant_customs' inputSchema. */
export interface AuditVariantCustomsParams {
  includeVariants: boolean;
  limit: number;
}

/**
 * Core logic behind shopify_audit_variant_customs, extracted so it can be
 * unit tested with an injected gql. Returns the plain result payload; the
 * registered tool wraps it with ok()/err().
 */
export async function runAuditVariantCustoms(
  params: AuditVariantCustomsParams,
  gql: GqlFn
): Promise<Record<string, unknown>> {
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

  return {
    total_variants: total,
    missing_hs_code: missingHs,
    missing_origin: missingOrigin,
    complete: total - missing.length,
    hs_codes_in_use: [...codeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, variants: count })),
    variants: params.includeVariants ? missing.slice(0, params.limit) : [],
    variants_total_missing: missing.length,
  };
}

/**
 * Wraps runAuditVariantCustoms in an okList response so the missing-variant list
 * is trimmed by ITEM COUNT (never mid-object) if it would exceed CHARACTER_LIMIT —
 * see FINDING 1: ok()/truncate() cuts the serialized JSON string mid-record, and
 * this store's ~900 variants blow that budget on the very "show me everything
 * missing" call the tool exists for. okList reports its own returned/of/truncated
 * for the (limit-capped) variants list; variants_total_missing stays alongside it
 * as the true, uncapped total so a low limit never makes coverage look better
 * than it is.
 */
export async function buildAuditVariantCustomsResult(
  params: AuditVariantCustomsParams,
  gql: GqlFn
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { variants, ...totals } = await runAuditVariantCustoms(params, gql);
  return okList("variants", (variants as Array<Record<string, unknown>>) ?? [], totals);
}

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
        return ok(await runBulkUpdateVariants(params, gql));
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
        return await buildAuditVariantCustomsResult(params, gql);
      } catch (error) { return err(error); }
    }
  );
}
