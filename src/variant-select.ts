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

export interface ScanNode {
  id: string;
  sku: string | null;
  product: { id: string };
  inventoryItem: { harmonizedSystemCode: string | null; countryCodeOfOrigin: string | null };
}

export interface ScanResponse {
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
