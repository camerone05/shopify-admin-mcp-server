# Scope Coverage & Bulk Variant Updates — Design

Date: 2026-07-27
Target: `shopify-orders-mcp-server` v4.0.0, Shopify Admin GraphQL API 2026-01

## Problem

Every variant write in this server is one-SKU-at-a-time. Setting an HS/HTS code, a cost, or a
price across the catalogue is impractical to drive from an agent. Separately, several granted
scopes have no tools at all.

## Evidence

Measured against the live store on 2026-07-27, not assumed:

- **Token holds 26 scopes**, of which only 5 are write: `write_products`, `write_inventory`,
  `write_content`, `write_online_store_pages`, `write_inventory_transfers`.
  There is no `write_customers`, `write_orders`, `write_discounts` or `write_price_rules`,
  so orders, customers and discounts stay read-only no matter what the API offers.
- **Catalogue: 146 products, 896 variants.** 130 variants (14.5%) have no HS code and 131
  (14.6%) have no country of origin. Only 7 distinct HS codes are in use across the catalogue.
- **ShopifyQL works** with this token, returning live sales data. The Level 2 protected-customer-data
  requirement documented for `shopifyqlQuery` is satisfied.
- **Marketing events return 0 records**; customer events return 3 across 10 repeat customers.
  Tools are still in scope by explicit decision, so they work the day data appears. Until then
  they will correctly return empty results — that is expected, not a defect.

The 130-variant backfill size is the single most important number here: it rules out the
async bulk API on cost/benefit grounds.

## Approach

### Bulk engine: grouped `productVariantsBulkUpdate`

`ProductVariantsBulkInput` accepts both variant-level fields and a nested
`inventoryItem: InventoryItemInput`. A single mutation carrying all 15 fields below was
schema-validated against 2026-01, so one synchronous call can update up to 250 variants of one
product across pricing, identifiers, customs and shipping weight together.

Rejected alternatives:

- **`bulkOperationRunMutation` + staged JSONL upload.** Requires `stagedUploadsCreate`, an HTTP
  file POST, the bulk mutation, polling `currentBulkOperation`, then downloading and parsing a
  result JSONL. Shopify permits one bulk mutation per shop at a time. For 130 records this is
  more failure modes and slower end-to-end than the grouped call. Revisit above ~10k variants;
  the grouping logic ports over unchanged.
- **Concurrency-limited `inventoryItemUpdate` loop.** Simplest, but N calls instead of N/100 and
  it forfeits per-product batch atomicity. The existing single-SKU tool already covers this case.

### Module layout

```
src/bulk.ts                  shared grouped-bulk engine
src/tools/bulk-variants.ts   bulk variant update + customs audit
src/tools/analytics.ts       ShopifyQL
src/tools/marketing.ts       marketing events + customer events
```

`src/bulk.ts` knows nothing about which fields it is writing. It accepts variant GIDs plus a
field payload, groups by product, chunks, executes, and aggregates results. This boundary is what
keeps the engine unit-testable independently of field semantics.

## Tool surface

5 new tools, taking the server from 48 to 53.

| Module | Tool | Annotation |
|---|---|---|
| bulk-variants | `shopify_bulk_update_variants` | write-safe |
| bulk-variants | `shopify_audit_variant_customs` | read-only |
| analytics | `shopify_analytics_query` | read-only |
| marketing | `shopify_list_marketing_events` | read-only |
| marketing | `shopify_get_customer_events` | read-only |

## Semantics

### Selection

`shopify_bulk_update_variants` selectors, combined with AND, at least one required:

| Selector | Meaning |
|---|---|
| `skus[]` | Explicit SKU list |
| `productIds[]` | Every variant of those products |
| `query` | Shopify variant search, e.g. `product_type:Socks` |
| `onlyMissingHsCode` | Restrict to variants with no HS code |
| `onlyMissingOrigin` | Restrict to variants with no country of origin |

`onlyMissingHsCode: true` plus a code is what turns the 130-variant backfill into a single call
with no SKU list to assemble.

### Settable fields

| Level | Fields |
|---|---|
| Variant | `price`, `compareAtPrice`, `barcode`, `taxable`, `taxCode`, `inventoryPolicy` |
| InventoryItem | `cost`, `tracked`, `requiresShipping`, `harmonizedSystemCode`, `countryCodeOfOrigin`, `provinceCodeOfOrigin`, `countryHarmonizedSystemCodes`, `weight` |

`harmonizedSystemCode` and `countryCodeOfOrigin` reuse the `normaliseHsCode` and
`normaliseCountryCode` helpers already in `src/tools/inventory.ts`, which strip dots/spaces from
tariff codes and uppercase country codes.

**`sku` is deliberately excluded**, though `InventoryItemInput` accepts it. Bulk-rewriting SKUs
would break the mechanism used to address variants: both the `skus[]` selector and
`resolveVariant` key off SKU, so a partial failure mid-run would leave the un-updated variants
unaddressable for a retry. Single-SKU changes remain available via the existing tools.

### Safety

- **`dryRun` default is computed, not fixed.** It defaults to `true` when `price` or
  `compareAtPrice` is present in the payload, and `false` otherwise. Writing prices therefore
  requires an explicit `dryRun: false`; customs, cost and identifier writes execute in one call.
  The asymmetry is deliberate and targets the actual risk: a wrong HS code is a correctable
  customs annoyance, whereas a wrong bulk price is live on the storefront and revenue-affecting
  the moment it lands. The rule is stateless — it reads only the current payload, never prior
  calls — so it is safe under MCP's request model.
- **`dryRun: true` writes nothing** and returns the per-variant `current → new` diff plus counts.
- **`maxVariants` defaults to 500.** Exceeding it is a hard refusal naming the match count, never
  a silent truncation. Silent caps read as "covered everything" when they did not. For non-price
  writes this refusal and `shopify_audit_variant_customs` are the only guardrails, so neither may
  be weakened without revisiting the other.
- **Chunk at 100 variants per call**, below the documented 250. Nested `inventoryItem` payloads
  carry per-field query cost and 250 risks tripping the cost ceiling, which surfaces as an opaque
  throttle rather than a clear error.

### Error handling

One call per product means partial failure is expected, not exceptional. The tool returns:

```json
{
  "success": false,
  "updated": [ { "variant_id": "...", "sku": "...", "changed": { "...": "..." } } ],
  "failed":  [ { "product_id": "...", "errors": [ "..." ] } ]
}
```

`success` is `false` if *any* product failed. The tool never reports a clean success over a
partial write.

### ShopifyQL

A malformed query returns HTTP 200 with a populated `parseErrors` array and empty `tableData`.
Returning that verbatim reads as "your store has no sales". `shopify_analytics_query` treats
non-empty `parseErrors` as a hard error and surfaces the messages.

## Schema notes

All operations validated against 2026-01 via the Shopify dev MCP validator. Corrections found
during validation, recorded so they are not re-derived:

- `InventoryItem.variant` is deprecated; use `variants`.
- Customer events sit under the `read_customers` scope, not `read_customer_events`.
- Variant weight is set via `inventoryItem.measurement.weight { value, unit }`, not a top-level
  `weight` field.
- The validator reports `read_markets_home` as required for queries selecting
  `countryHarmonizedSystemCodes`. This is over-reported: the same query was confirmed working
  live against a token that lacks that scope. Do not add it as a requirement.

## Testing

The repo currently has no test framework. This build adds `vitest` and unit tests against a
mocked GraphQL client, covering:

- `normaliseHsCode` / `normaliseCountryCode` — accepted formats and rejection messages
- group-by-product and chunking in `src/bulk.ts`, including the 100-variant boundary
- selector → Shopify query construction, including AND combination
- the computed `dryRun` default — `true` when price fields are present, `false` otherwise, and
  that an explicit value always wins over the computed one
- that `sku` is rejected if passed to the bulk tool
- partial-failure aggregation — that `success` is `false` when any product fails
- ShopifyQL parse-error mapping — that `parseErrors` becomes an error, not empty data
- `maxVariants` refusal rather than truncation

Network paths are mocked. No live-store integration tests: the store is production.

## Out of scope

- **Inventory transfers.** Considered and dropped. The existing `shopify_move_inventory`
  (`inventoryMoveQuantities`) already performs instant, transactional stock movement between
  locations, which is the actual use case. Inventory transfers model a tracked multi-day
  shipment with a draft → ready-to-ship → received lifecycle, which this store does not need
  driven from an agent. This leaves `read_inventory_transfers` / `write_inventory_transfers`
  deliberately unserved.
- **`bulkOperationRunMutation` backend.** Revisit above ~10k variants.
- **Bulk `sku` rewriting.** See Settable fields above.
- **Write tools for scopes the token lacks**: customers, orders, discounts, price rules.
- **Setting customs data at variant creation time.** `shopify_create_variants` currently maps only
  `sku` into `inventoryItem`. Worth a follow-up, but it is a different tool and a different risk.

## Notes

Per standing instruction, this document is written to disk but **not** committed; no git
operations are performed against this repository.
