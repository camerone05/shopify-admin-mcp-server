/**
 * Resolution helpers shared by the inventory and product tools.
 *
 * These let callers work in the terms they actually think in — a SKU, a
 * location name — instead of having to hand-look-up Shopify GIDs first.
 */

import { shopifyGraphQL, quoteQueryValue } from "./shopify-client.js";

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Variant plus its per-location stocking state. */
const VARIANT_LOCATION_FIELDS = `
  id title sku displayName price inventoryQuantity
  product { id title status }
  inventoryItem {
    id tracked requiresShipping
    harmonizedSystemCode countryCodeOfOrigin provinceCodeOfOrigin
    countryHarmonizedSystemCodes(first: 20) {
      nodes { countryCode harmonizedSystemCode }
    }
    inventoryLevels(first: 50) {
      nodes {
        id canDeactivate deactivationAlert
        location { id name isActive fulfillsOnlineOrders }
        quantities(names: ["available", "on_hand", "committed", "incoming"]) { name quantity }
      }
    }
  }
`;

export const VARIANT_SEARCH_QUERY = `
  query FindVariants($query: String!, $first: Int!) {
    productVariants(first: $first, query: $query) {
      nodes { ${VARIANT_LOCATION_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const VARIANT_BY_ID_LOCATION_QUERY = `
  query GetVariantLocations($id: ID!) {
    productVariant(id: $id) { ${VARIANT_LOCATION_FIELDS} }
  }
`;

export const LOCATIONS_QUERY = `
  query GetLocations($first: Int!) {
    locations(first: $first) {
      nodes {
        id name isActive fulfillsOnlineOrders
        address { address1 address2 city province country zip phone }
      }
    }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InventoryLevelNode {
  id: string;
  canDeactivate: boolean;
  deactivationAlert: string | null;
  location: { id: string; name: string; isActive: boolean; fulfillsOnlineOrders: boolean };
  quantities: Array<{ name: string; quantity: number }>;
}

export interface VariantLocationNode {
  id: string;
  title: string;
  sku: string | null;
  displayName: string;
  price: string;
  inventoryQuantity: number | null;
  product: { id: string; title: string; status: string };
  inventoryItem: {
    id: string;
    tracked: boolean;
    requiresShipping: boolean;
    harmonizedSystemCode: string | null;
    countryCodeOfOrigin: string | null;
    provinceCodeOfOrigin: string | null;
    countryHarmonizedSystemCodes: {
      nodes: Array<{ countryCode: string; harmonizedSystemCode: string }>;
    };
    inventoryLevels: { nodes: InventoryLevelNode[] };
  };
}

export interface LocationNode {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
}

// ─── Resolvers ───────────────────────────────────────────────────────────────

/**
 * Resolve a variant from an exact SKU or a variant GID.
 *
 * Throws when a SKU matches zero or more than one variant, so a write can
 * never silently land on the wrong variant.
 */
export async function resolveVariant(params: { sku?: string; variantId?: string }): Promise<VariantLocationNode> {
  if (params.variantId) {
    const data = await shopifyGraphQL<{ productVariant: VariantLocationNode | null }>(
      VARIANT_BY_ID_LOCATION_QUERY,
      { id: params.variantId }
    );
    if (!data.productVariant) throw new Error(`Variant ${params.variantId} not found`);
    return data.productVariant;
  }

  if (!params.sku) throw new Error("Provide either sku or variantId");

  const data = await shopifyGraphQL<{ productVariants: { nodes: VariantLocationNode[] } }>(
    VARIANT_SEARCH_QUERY,
    { query: `sku:${quoteQueryValue(params.sku)}`, first: 10 }
  );
  // Shopify's `sku:` filter is a token/prefix match, so narrow to an exact hit.
  const exact = data.productVariants.nodes.filter((v) => v.sku === params.sku);

  if (exact.length === 0) throw new Error(`No variant found with SKU "${params.sku}"`);
  if (exact.length > 1) {
    const dupes = exact.map((v) => `${v.id} (${v.product.title} — ${v.title})`).join(", ");
    throw new Error(
      `SKU "${params.sku}" matches ${exact.length} variants: ${dupes}. Pass variantId to disambiguate.`
    );
  }
  return exact[0];
}

export async function fetchLocations(): Promise<LocationNode[]> {
  const data = await shopifyGraphQL<{ locations: { nodes: LocationNode[] } }>(LOCATIONS_QUERY, { first: 250 });
  return data.locations.nodes;
}

/** Resolve a location reference — GID or human-readable name — to a Location GID. */
export function resolveLocationId(reference: string, locations: LocationNode[]): string {
  if (reference.startsWith("gid://shopify/Location/")) return reference;

  const matches = locations.filter((l) => l.name.toLowerCase() === reference.toLowerCase());
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`Location name "${reference}" is ambiguous — pass the location GID instead`);
  }

  const available = locations.map((l) => l.name).join(", ");
  throw new Error(`Location "${reference}" not found. Available locations: ${available}`);
}

/** Present a variant's stocking state as active vs inactive locations. */
export function formatVariantLocations(variant: VariantLocationNode, allLocations: LocationNode[]) {
  const levels = variant.inventoryItem.inventoryLevels.nodes;
  const stockedIds = new Set(levels.map((l) => l.location.id));

  return {
    variant: {
      id: variant.id,
      sku: variant.sku,
      title: variant.displayName,
      price: variant.price,
      total_inventory: variant.inventoryQuantity,
      product: variant.product,
    },
    inventory_item_id: variant.inventoryItem.id,
    tracked: variant.inventoryItem.tracked,
    // Customs data — null means unset, which blocks international label generation.
    customs: {
      harmonized_system_code: variant.inventoryItem.harmonizedSystemCode,
      country_code_of_origin: variant.inventoryItem.countryCodeOfOrigin,
      province_code_of_origin: variant.inventoryItem.provinceCodeOfOrigin,
      requires_shipping: variant.inventoryItem.requiresShipping,
      // Per-destination HS overrides; the top-level code applies when empty.
      country_specific_codes: variant.inventoryItem.countryHarmonizedSystemCodes.nodes.map((c) => ({
        country_code: c.countryCode,
        harmonized_system_code: c.harmonizedSystemCode,
      })),
    },
    // Locations where this variant IS stocked and can be fulfilled from.
    active_locations: levels.map((l) => ({
      location_id: l.location.id,
      location_name: l.location.name,
      location_is_active: l.location.isActive,
      fulfills_online_orders: l.location.fulfillsOnlineOrders,
      inventory_level_id: l.id,
      can_deactivate: l.canDeactivate,
      deactivation_blocked_reason: l.deactivationAlert,
      quantities: Object.fromEntries(l.quantities.map((q) => [q.name, q.quantity])),
    })),
    // Locations where it is NOT stocked — activate one to enable fulfilment there.
    inactive_locations: allLocations
      .filter((l) => !stockedIds.has(l.id))
      .map((l) => ({ location_id: l.id, location_name: l.name, location_is_active: l.isActive })),
  };
}
