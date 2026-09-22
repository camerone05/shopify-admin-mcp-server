/**
 * Inventory & location tools.
 *
 * Scopes used: read_inventory, write_inventory, read_locations.
 *
 * The two headline tools here are shopify_get_variant_locations and
 * shopify_set_variant_locations — they let you turn a location's ability to
 * stock and fulfil a variant on and off, addressed by SKU rather than by GID.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  shopifyGraphQL, checkUserErrors, ok, err,
  READ_ONLY, WRITE_SAFE, WRITE_CREATE, WRITE_DESTRUCTIVE,
} from "../shopify-client.js";
import {
  LOCATIONS_QUERY, resolveVariant, fetchLocations, resolveLocationId,
  formatVariantLocations, type LocationNode,
} from "../resolvers.js";
import { normaliseHsCode, normaliseCountryCode } from "../variant-fields.js";

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const INVENTORY_LEVELS_QUERY = `
  query GetInventoryLevels($variantId: ID!) {
    productVariant(id: $variantId) {
      id title sku
      inventoryItem {
        id tracked
        inventoryLevels(first: 20) {
          edges {
            node {
              id
              location { id name }
              quantities(names: ["available", "on_hand", "committed", "incoming"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;

// Activates/deactivates an inventory item at one or more locations in one call.
const INVENTORY_TOGGLE_ACTIVATION_MUTATION = `
  mutation ToggleInventoryActivation($inventoryItemId: ID!, $inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!) {
    inventoryBulkToggleActivation(inventoryItemId: $inventoryItemId, inventoryItemUpdates: $inventoryItemUpdates) {
      inventoryItem { id sku tracked }
      inventoryLevels {
        id
        location { id name }
        quantities(names: ["available", "on_hand"]) { name quantity }
      }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_ADJUST_MUTATION = `
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes {
          name delta quantityAfterChange
          item { id sku }
          location { id name }
        }
      }
      userErrors { field message }
    }
  }
`;

const INVENTORY_SET_MUTATION = `
  mutation SetInventoryQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason createdAt
        changes {
          name delta quantityAfterChange
          item { id sku }
          location { id name }
        }
      }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_MOVE_MUTATION = `
  mutation MoveInventory($input: InventoryMoveQuantitiesInput!) {
    inventoryMoveQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason createdAt
        changes {
          name delta quantityAfterChange
          item { id sku }
          location { id name }
        }
      }
      userErrors { field message code }
    }
  }
`;

const INVENTORY_ITEM_UPDATE_MUTATION = `
  mutation UpdateInventoryItem($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id sku tracked requiresShipping
        countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode
        countryHarmonizedSystemCodes(first: 20) {
          nodes { countryCode harmonizedSystemCode }
        }
        unitCost { amount currencyCode }
      }
      userErrors { field message }
    }
  }
`;

const ADJUST_REASONS = [
  "correction", "received", "returned", "damaged", "theft", "shrinkage", "restock", "other",
] as const;

// ─── Registration ────────────────────────────────────────────────────────────

export function registerInventoryTools(server: McpServer): void {
  server.registerTool(
    "shopify_get_locations",
    {
      title: "Get Shopify Locations",
      description: `All store locations: name, address, active status, and whether each fulfills online orders.`,
      inputSchema: {
        limit: z.number().int().min(1).max(250).default(50),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ locations: { nodes: Array<Record<string, unknown>> } }>(
          LOCATIONS_QUERY, { first: params.limit }
        );
        return ok({ locations: data.locations.nodes });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_variant_locations",
    {
      title: "Get Variant Location Fulfilment State",
      description: `Look up a variant by SKU (or variant GID) and see exactly which locations stock and fulfil it.

Returns:
  - active_locations: locations that CAN stock & fulfil this variant, with available/on_hand/committed/incoming
    quantities, plus can_deactivate and any deactivation_blocked_reason
  - inactive_locations: locations that CANNOT — activate one with shopify_set_variant_locations
  - inventory_item_id: needed by shopify_adjust_inventory / shopify_set_inventory

Call this before shopify_set_variant_locations to see the current state.`,
      inputSchema: {
        sku: z.string().optional().describe("Exact variant SKU e.g. 'TSHIRT-BLK-M'"),
        variantId: z.string().optional().describe("Variant GID — use instead of sku when the SKU is ambiguous or blank"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        if (!params.sku && !params.variantId) throw new Error("Provide either sku or variantId");
        const [variant, locations] = await Promise.all([resolveVariant(params), fetchLocations()]);
        return ok(formatVariantLocations(variant, locations));
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_set_variant_locations",
    {
      title: "Activate/Deactivate Variant Fulfilment at Locations",
      description: `Turn location fulfilment ON or OFF for a variant, identified by SKU or variant GID.

  - activate: true  → the location can stock and fulfil this variant (starts at 0 available;
                      follow with shopify_set_inventory to set stock)
  - activate: false → the location no longer stocks the variant, and its stock there is discarded

Locations may be given as a GID or by name (e.g. "Melbourne Warehouse"), matched case-insensitively.
Multiple locations are applied in a single call.

DEACTIVATION IS DESTRUCTIVE: it discards that location's inventory for the variant. Shopify refuses when the
variant has committed stock or pending fulfilments there — check can_deactivate via shopify_get_variant_locations first.`,
      inputSchema: {
        sku: z.string().optional().describe("Exact variant SKU"),
        variantId: z.string().optional().describe("Variant GID — use instead of sku when the SKU is ambiguous"),
        locations: z.array(z.object({
          location: z.string().min(1).describe("Location GID or location name"),
          activate: z.boolean().describe("true = stock & fulfil here, false = stop stocking here"),
        })).min(1).describe("Locations to activate or deactivate"),
      },
      annotations: WRITE_DESTRUCTIVE,
    },
    async (params) => {
      try {
        if (!params.sku && !params.variantId) throw new Error("Provide either sku or variantId");

        const [variant, allLocations] = await Promise.all([resolveVariant(params), fetchLocations()]);

        const updates = params.locations.map((l) => ({
          locationId: resolveLocationId(l.location, allLocations),
          activate: l.activate,
        }));

        const data = await shopifyGraphQL<{
          inventoryBulkToggleActivation: {
            inventoryItem: { id: string };
            userErrors: Array<{ field?: string[]; message: string; code?: string }>;
          };
        }>(INVENTORY_TOGGLE_ACTIVATION_MUTATION, {
          inventoryItemId: variant.inventoryItem.id,
          inventoryItemUpdates: updates,
        });
        checkUserErrors(data.inventoryBulkToggleActivation.userErrors, "toggle location activation");

        // Re-read so the caller sees the settled state, not just the activated levels.
        const refetched = await resolveVariant({ variantId: variant.id });

        return ok({
          success: true,
          applied: updates.map((u) => ({
            location_id: u.locationId,
            location_name: allLocations.find((l: LocationNode) => l.id === u.locationId)?.name ?? null,
            action: u.activate ? "activated" : "deactivated",
          })),
          ...formatVariantLocations(refetched, allLocations),
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_inventory_levels",
    {
      title: "Get Inventory Levels for Variant",
      description: `Inventory quantities at each location for a specific variant: available, on_hand, committed, incoming.

Prefer shopify_get_variant_locations — it accepts a SKU and also shows which locations are NOT stocking the variant.`,
      inputSchema: {
        variantId: z.string().min(1).describe("Variant GID e.g. gid://shopify/ProductVariant/1234567890"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ productVariant: Record<string, unknown> | null }>(
          INVENTORY_LEVELS_QUERY, { variantId: params.variantId }
        );
        if (!data.productVariant) throw new Error(`Variant ${params.variantId} not found`);
        return ok({ variant: data.productVariant });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_adjust_inventory",
    {
      title: "Adjust Shopify Inventory (by delta)",
      description: `Change stock by a RELATIVE amount at one location — e.g. delta: -3 to remove three units.

Accepts a SKU (preferred) or an explicit inventoryItemId. Location may be a GID or a name.
To set an exact number instead of a delta, use shopify_set_inventory.

The variant must already be stocked at the location — activate it first with shopify_set_variant_locations.`,
      inputSchema: {
        sku: z.string().optional().describe("Exact variant SKU"),
        inventoryItemId: z.string().optional().describe("InventoryItem GID — alternative to sku"),
        location: z.string().min(1).describe("Location GID or location name"),
        delta: z.number().int().describe("Change: positive adds stock, negative removes it"),
        name: z.enum(["available", "on_hand"]).default("available").describe("Which quantity to adjust"),
        reason: z.enum(ADJUST_REASONS).default("correction"),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const [inventoryItemId, locations] = await Promise.all([
          resolveInventoryItemId(params),
          fetchLocations(),
        ]);
        const locationId = resolveLocationId(params.location, locations);

        const data = await shopifyGraphQL<{
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: Record<string, unknown>;
            userErrors: Array<{ field?: string[]; message: string }>;
          };
        }>(INVENTORY_ADJUST_MUTATION, {
          input: {
            name: params.name,
            reason: params.reason,
            changes: [{ inventoryItemId, locationId, delta: params.delta }],
          },
        });
        checkUserErrors(data.inventoryAdjustQuantities.userErrors, "adjust inventory");
        return ok({ success: true, adjustment: data.inventoryAdjustQuantities.inventoryAdjustmentGroup });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_set_inventory",
    {
      title: "Set Shopify Inventory (absolute)",
      description: `Set stock to an EXACT number at one or more locations — e.g. quantity: 42 means "there are now 42".

Use this for stocktakes and when syncing from a system that is the source of truth. For relative changes
("we sold 3"), use shopify_adjust_inventory instead.

Concurrency: by default this uses compare-and-set — pass compareQuantity (the quantity you believe is currently
there) and Shopify rejects the write if someone changed it underneath you. Set ignoreCompareQuantity: true to
force the write regardless, which risks clobbering a concurrent update.

The variant must already be stocked at the location — activate it first with shopify_set_variant_locations.`,
      inputSchema: {
        sku: z.string().optional().describe("Exact variant SKU"),
        inventoryItemId: z.string().optional().describe("InventoryItem GID — alternative to sku"),
        quantities: z.array(z.object({
          location: z.string().min(1).describe("Location GID or location name"),
          quantity: z.number().int().min(0).describe("The exact quantity there should be after this call"),
          compareQuantity: z.number().int().optional().describe("The quantity you believe is currently set — omit only with ignoreCompareQuantity"),
        })).min(1),
        name: z.enum(["available", "on_hand"]).default("available").describe("Which quantity to set"),
        reason: z.enum(ADJUST_REASONS).default("correction"),
        ignoreCompareQuantity: z.boolean().default(false).describe("Skip the compare-and-set safety check"),
        referenceDocumentUri: z.string().optional().describe("Traceability URI e.g. 'logistics://warehouse/stocktake/2026-01-14'"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const [inventoryItemId, locations] = await Promise.all([
          resolveInventoryItemId(params),
          fetchLocations(),
        ]);

        const missingCompare = params.quantities.some((q) => q.compareQuantity === undefined);
        if (missingCompare && !params.ignoreCompareQuantity) {
          throw new Error(
            "Each quantity needs compareQuantity (the value you expect is currently set), " +
            "or pass ignoreCompareQuantity: true to overwrite unconditionally. " +
            "Use shopify_get_variant_locations to read the current quantities."
          );
        }

        const data = await shopifyGraphQL<{
          inventorySetQuantities: {
            inventoryAdjustmentGroup: Record<string, unknown>;
            userErrors: Array<{ field?: string[]; message: string; code?: string }>;
          };
        }>(INVENTORY_SET_MUTATION, {
          input: {
            name: params.name,
            reason: params.reason,
            ignoreCompareQuantity: params.ignoreCompareQuantity,
            ...(params.referenceDocumentUri ? { referenceDocumentUri: params.referenceDocumentUri } : {}),
            quantities: params.quantities.map((q) => ({
              inventoryItemId,
              locationId: resolveLocationId(q.location, locations),
              quantity: q.quantity,
              ...(q.compareQuantity !== undefined ? { compareQuantity: q.compareQuantity } : {}),
            })),
          },
        });
        checkUserErrors(data.inventorySetQuantities.userErrors, "set inventory");
        return ok({ success: true, adjustment: data.inventorySetQuantities.inventoryAdjustmentGroup });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_move_inventory",
    {
      title: "Move Inventory Between Locations",
      description: `Move stock of one variant from one location to another in a single transactional call —
the origin is decremented and the destination incremented together.

Both locations must already stock the variant (activate with shopify_set_variant_locations first).

quantityName pairs the ledger states being moved between, e.g. moving 'available' at the origin to
'available' at the destination. For most stock transfers, leave both as 'available'.`,
      inputSchema: {
        sku: z.string().optional().describe("Exact variant SKU"),
        inventoryItemId: z.string().optional().describe("InventoryItem GID — alternative to sku"),
        fromLocation: z.string().min(1).describe("Origin location GID or name"),
        toLocation: z.string().min(1).describe("Destination location GID or name"),
        quantity: z.number().int().min(1).describe("Units to move"),
        fromName: z.enum(["available", "on_hand"]).default("available"),
        toName: z.enum(["available", "on_hand"]).default("available"),
        reason: z.enum(ADJUST_REASONS).default("correction"),
        referenceDocumentUri: z.string().optional().describe("Traceability URI for this movement"),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const [inventoryItemId, locations] = await Promise.all([
          resolveInventoryItemId(params),
          fetchLocations(),
        ]);
        const from = resolveLocationId(params.fromLocation, locations);
        const to = resolveLocationId(params.toLocation, locations);
        if (from === to) throw new Error("fromLocation and toLocation must be different");

        const data = await shopifyGraphQL<{
          inventoryMoveQuantities: {
            inventoryAdjustmentGroup: Record<string, unknown>;
            userErrors: Array<{ field?: string[]; message: string; code?: string }>;
          };
        }>(INVENTORY_MOVE_MUTATION, {
          input: {
            reason: params.reason,
            ...(params.referenceDocumentUri ? { referenceDocumentUri: params.referenceDocumentUri } : {}),
            changes: [{
              inventoryItemId,
              quantity: params.quantity,
              from: { locationId: from, name: params.fromName },
              to: { locationId: to, name: params.toName },
            }],
          },
        });
        checkUserErrors(data.inventoryMoveQuantities.userErrors, "move inventory");
        return ok({
          success: true,
          moved: params.quantity,
          from: locations.find((l: LocationNode) => l.id === from)?.name ?? from,
          to: locations.find((l: LocationNode) => l.id === to)?.name ?? to,
          adjustment: data.inventoryMoveQuantities.inventoryAdjustmentGroup,
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_update_inventory_item",
    {
      title: "Update Inventory Item Settings",
      description: `Update a variant's inventory-item settings — the per-SKU attributes that aren't pricing:

  - tracked: whether Shopify tracks stock for this SKU at all (untracked SKUs always sell)
  - cost: unit cost, used for profit reporting and COGS
  - requiresShipping: false for digital or service items

Customs / HTS fields, needed before Shopify will generate international shipping labels:

  - harmonizedSystemCode: the HS/HTS tariff code, 6 to 13 digits. Dots and spaces are stripped,
    so '6110.20.20' and '61102020' are both accepted.
  - countryCodeOfOrigin: 2-letter ISO country where the item was made, e.g. 'AU', 'CN'
  - provinceCodeOfOrigin: province/state code, only used by a few destinations (e.g. 'BC' for Canada)
  - countryHarmonizedSystemCodes: destination-specific HTS overrides, for when a country wants a
    longer national code than your 6-digit base. Replaces the whole override list.

Read the current values back with shopify_get_variant_locations.
Accepts a SKU or an explicit inventoryItemId. Only provided fields change.`,
      inputSchema: {
        sku: z.string().optional().describe("Exact variant SKU"),
        inventoryItemId: z.string().optional().describe("InventoryItem GID — alternative to sku"),
        tracked: z.boolean().optional().describe("Whether Shopify tracks stock for this SKU"),
        cost: z.string().optional().describe("Unit cost e.g. '12.50'"),
        harmonizedSystemCode: z.string().optional().describe("HS/HTS tariff code, 6-13 digits e.g. '611020' or '6110.20.20'"),
        countryCodeOfOrigin: z.string().optional().describe("2-letter ISO country code e.g. 'AU', 'CN' — case-insensitive"),
        provinceCodeOfOrigin: z.string().optional().describe("Province/state code e.g. 'BC' — only needed for some destinations"),
        countryHarmonizedSystemCodes: z.array(z.object({
          countryCode: z.string().describe("2-letter ISO destination country e.g. 'US'"),
          harmonizedSystemCode: z.string().describe("HTS code for that destination e.g. '6110.20.2020'"),
        })).optional().describe("Destination-specific HTS overrides — replaces the existing list"),
        requiresShipping: z.boolean().optional().describe("false for digital/service items"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const { sku, inventoryItemId, ...fields } = params;
        const itemId = await resolveInventoryItemId(params);

        const input: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined)
        );
        if (Object.keys(input).length === 0) throw new Error("Provide at least one field to update");

        // Shopify types these as enums/strict strings — normalise so merchant-formatted
        // input ('au', '6110.20.20') doesn't come back as an opaque GraphQL coercion error.
        if (fields.harmonizedSystemCode !== undefined) {
          input.harmonizedSystemCode = normaliseHsCode(fields.harmonizedSystemCode, "harmonizedSystemCode");
        }
        if (fields.countryCodeOfOrigin !== undefined) {
          input.countryCodeOfOrigin = normaliseCountryCode(fields.countryCodeOfOrigin, "countryCodeOfOrigin");
        }
        if (fields.provinceCodeOfOrigin !== undefined) {
          input.provinceCodeOfOrigin = fields.provinceCodeOfOrigin.trim().toUpperCase();
        }
        if (fields.countryHarmonizedSystemCodes !== undefined) {
          input.countryHarmonizedSystemCodes = fields.countryHarmonizedSystemCodes.map((c) => ({
            countryCode: normaliseCountryCode(c.countryCode, "countryHarmonizedSystemCodes.countryCode"),
            harmonizedSystemCode: normaliseHsCode(
              c.harmonizedSystemCode, "countryHarmonizedSystemCodes.harmonizedSystemCode"
            ),
          }));
        }

        const data = await shopifyGraphQL<{
          inventoryItemUpdate: {
            inventoryItem: Record<string, unknown>;
            userErrors: Array<{ field?: string[]; message: string }>;
          };
        }>(INVENTORY_ITEM_UPDATE_MUTATION, { id: itemId, input });
        checkUserErrors(data.inventoryItemUpdate.userErrors, "update inventory item");
        return ok({ success: true, inventory_item: data.inventoryItemUpdate.inventoryItem });
      } catch (error) { return err(error); }
    }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Accept either a SKU or an explicit InventoryItem GID and return the GID. */
async function resolveInventoryItemId(params: { sku?: string; inventoryItemId?: string }): Promise<string> {
  if (params.inventoryItemId) return params.inventoryItemId;
  if (!params.sku) throw new Error("Provide either sku or inventoryItemId");
  const variant = await resolveVariant({ sku: params.sku });
  return variant.inventoryItem.id;
}
