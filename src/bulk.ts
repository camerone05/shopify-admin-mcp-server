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
