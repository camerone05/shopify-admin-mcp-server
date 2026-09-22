# Shopify MCP Server v4.0.0

Shopify Admin GraphQL API **2026-01** MCP server. 54 tools aligned to the OAuth scopes actually granted on the token — orders, products, variants, media, inventory & per-location fulfilment, customers, collections, discounts, abandoned checkouts, blog content, pages, metafields, bulk variant updates, and analytics.

Every GraphQL operation is validated against the 2026-01 schema, and all 24 read tools plus the inventory write tools are verified against a live store.

```bash
npx -y shopify-admin-mcp-server
```

Requires `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_ACCESS_TOKEN`. Full setup in [Setup](#setup).

## Location fulfilment by SKU

The headline capability: turn a location's ability to stock and fulfil a variant on or off, addressed by **SKU** rather than by GID.

```
shopify_get_variant_locations  { sku: "TSHIRT-BLK-M" }
  → active_locations:   where it IS stocked, with available/on_hand/committed/incoming,
                        plus can_deactivate and any deactivation_blocked_reason
  → inactive_locations: where it is NOT stocked
  → inventory_item_id:  for the stock tools below

shopify_set_variant_locations {
  sku: "TSHIRT-BLK-M",
  locations: [
    { location: "Melbourne Warehouse", activate: true  },   // by name or GID
    { location: "Pop-up Store",        activate: false }
  ]
}
```

Backed by `inventoryBulkToggleActivation`, so multiple locations are applied in one call. Activating starts the location at 0 available — follow with `shopify_set_inventory`.

**Deactivation is destructive:** it discards that location's stock for the variant. Shopify refuses when the variant has committed stock or pending fulfilments there. Check `can_deactivate` first.

Guardrails: a SKU that matches zero or more than one variant is rejected rather than guessed at, and an unknown location name lists the valid ones.

## Tools (54)

### Shop & Orders
| Tool | Scopes | Description |
|------|--------|-------------|
| `shopify_get_shop` | — | Store info: name, domain, plan, currency, timezone |
| `shopify_list_orders` | `read_orders` | List orders in a date range with financials and line items |
| `shopify_get_order` | `read_orders` | Single order by GID: addresses, fulfillments, refunds |
| `shopify_weekly_summary` | `read_orders` | Auto-paginated aggregate: revenue, AOV, product breakdown |
| `shopify_order_count` | `read_orders` | Lightweight count for a date range |

### Inventory & Locations
| Tool | Scopes | Description |
|------|--------|-------------|
| `shopify_get_locations` | `read_locations` | All store locations with addresses |
| `shopify_get_variant_locations` | `read_inventory` | **By SKU:** which locations stock/fulfil a variant, and which don't |
| `shopify_set_variant_locations` | `write_inventory` | **By SKU:** activate/deactivate fulfilment at locations |
| `shopify_get_inventory_levels` | `read_inventory` | Quantities per location for a variant GID |
| `shopify_adjust_inventory` | `write_inventory` | Change stock by a **delta** ("we sold 3") |
| `shopify_set_inventory` | `write_inventory` | Set stock to an **exact** value, with compare-and-set |
| `shopify_move_inventory` | `write_inventory` | Move stock between locations transactionally |
| `shopify_update_inventory_item` | `write_inventory` | Per-SKU settings: tracked, unit cost, HS/HTS code, country of origin |

### Customs / HTS data

`shopify_update_inventory_item` sets the customs fields Shopify needs before it will generate international
shipping labels — `harmonizedSystemCode` (6–13 digits; `6110.20.20` and `61102020` are both accepted),
`countryCodeOfOrigin`, `provinceCodeOfOrigin`, and per-destination `countryHarmonizedSystemCodes` overrides.
Country codes are case-insensitive. Read the current values back under `customs` in
`shopify_get_variant_locations`.

`shopify_set_inventory` defaults to compare-and-set: pass `compareQuantity` and Shopify rejects the write if
someone changed the value underneath you. `ignoreCompareQuantity: true` forces it, at the risk of clobbering a
concurrent update.

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

### Products, Variants & Media
| Tool | Scopes | Description |
|------|--------|-------------|
| `shopify_get_products` | `read_products` | List/search products with variants, inventory, pricing (paginated) |
| `shopify_bulk_tag_products` | `write_products` | Add tags to every product matching a search query, paging server-side; skips already-tagged products, supports `dryRun` |
| `shopify_get_product_by_id` | `read_products` | Full detail: variants, options, media, collections, SEO |
| `shopify_create_product` | `write_products` | Create a product, with options and images |
| `shopify_update_product` | `write_products` | Update fields and variant prices/SKUs |
| `shopify_delete_product` | `write_products` | **Permanent** delete (requires `confirm: true`) |
| `shopify_duplicate_product` | `write_products` | Copy a product; the copy defaults to DRAFT |
| `shopify_add_product_media` | `write_products` | Attach images/video from public URLs |
| `shopify_create_variants` | `write_products` | Add variants against the product's options |
| `shopify_delete_variants` | `write_products` | **Permanent** delete (requires `confirm: true`) |

### Customers
| Tool | Scopes | Description |
|------|--------|-------------|
| `shopify_search_customers` | `read_customers` | Search by name, email, or any Shopify filter |
| `shopify_get_customer` | `read_customers` | Full profile with addresses and recent orders |
| `shopify_add_tags` | `write_products` | Add tags to any Shopify resource |
| `shopify_remove_tags` | `write_products` | Remove tags from any Shopify resource |

### Collections
| Tool | Scopes | Description |
|------|--------|-------------|
| `shopify_get_collections` | `read_products` | List/search collections with SEO |
| `shopify_create_collection` | `write_products` | Create a manual or smart (rule-based) collection |
| `shopify_update_collection` | `write_products` | Update title, description, and SEO |
| `shopify_collection_add_products` | `write_products` | Add products to a manual collection (async) |
| `shopify_collection_remove_products` | `write_products` | Remove products from a manual collection (async) |

### Pages, Blogs & Articles
| Tool | Scopes | Description |
|------|--------|-------------|
| `shopify_get_pages` | `read_online_store_pages` | List/search store pages |
| `shopify_get_page_by_id` | `read_online_store_pages` | Full page content and publish status |
| `shopify_update_page` | `write_online_store_pages` | Update title, HTML body, handle, publish status |
| `shopify_get_blogs` | `read_content` | List/search blogs |
| `shopify_get_blog_by_id` | `read_content` | Blog with 10 most recent articles |
| `shopify_update_blog` | `write_content` | Update title, handle, comment policy |
| `shopify_get_articles` | `read_content` | Articles for a blog |
| `shopify_get_article_by_id` | `read_content` | Full article with HTML, author, tags |
| `shopify_create_article` | `write_content` | Create a blog article |
| `shopify_update_article` | `write_content` | Update content, tags, author, publish status |

### Search, Metafields & Commerce
| Tool | Scopes | Description |
|------|--------|-------------|
| `shopify_search` | `read_products` / `read_content` / `read_online_store_pages` | Unified search across products, articles, blogs, pages |
| `shopify_get_metafields` | varies by resource | Get metafields for any resource |
| `shopify_set_metafield` | varies by resource | Create or update a metafield |
| `shopify_delete_metafield` | varies by resource | Delete a metafield by GID |
| `shopify_list_draft_orders` | `read_draft_orders` | List draft orders with line items and totals |
| `shopify_list_discounts` | `read_discounts` | List all discounts (code + automatic) via `discountNodes` |
| `shopify_list_abandoned_checkouts` | `read_checkouts` | Abandoned checkouts with recovery URL and line items |

---

## Not included (scopes not granted)

These are deliberately absent — the tools would 403 at runtime. Add the scopes to the custom app and reinstall
to get a new token, then they can be built:

| Capability | Scopes needed |
|------------|---------------|
| Create/cancel fulfilments, tracking numbers, move fulfilment between locations | `write_fulfillments`, `read_fulfillments`, `*_merchant_managed_fulfillment_orders` |
| Order edits, refunds, cancellations, order tagging | `write_orders` |
| Returns | `read_returns`, `write_returns` |
| Create/complete draft orders | `write_draft_orders` |
| Create discount codes | `write_discounts` |
| Publish products to sales channels | `write_publications`, `read_publications` |
| Create/edit locations | `write_locations` |

---

## Architecture

```
src/
  index.ts             # entry point — wires the tool modules together
  shopify-client.ts    # config, GraphQL client (429 retry), errors, MCP response helpers
  resolvers.ts         # SKU → variant, location name → GID
  variant-fields.ts     # shared variant field validation/normalisation (HS codes, weight, etc.)
  variant-select.ts     # selector (skus/productIds/query/missing-customs) → concrete variant list
  bulk.ts                # field-agnostic bulk variant writer: grouping, chunking, per-product results
  tools/
    orders.ts         # shop, orders, summary, count
    products.ts       # products, variants, media
    inventory.ts      # locations, variant⇄location activation, stock
    customers.ts      # customers, resource tagging
    content.ts        # pages, blogs, articles, metafields, search
    commerce.ts       # collections, draft orders, discounts, abandoned checkouts
    bulk-variants.ts   # bulk variant field updates, customs coverage audit
    analytics.ts       # ShopifyQL query tool
    marketing.ts        # marketing events, customer event timelines
tests/
  *.test.ts            # Vitest unit tests — one file per module under test
```

Each module exports a single `registerXTools(server)` function. No file exceeds 800 lines.

---

## Setup

### 1. Create a Shopify Custom App

1. **Shopify Admin → Settings → Apps and sales channels → Develop apps**
2. Click **Create an app**
3. Under **Configure Admin API scopes**, enable:
   - `read_all_orders`, `read_orders`
   - `read_analytics`, `read_reports`, `read_customer_events`
   - `read_checkouts`
   - `read_customers`
   - `read_price_rules`, `read_discounts`
   - `read_draft_orders`
   - `read_inventory`, `write_inventory`, `read_inventory_transfers`, `write_inventory_transfers`
   - `read_locations`
   - `read_marketing_integrated_campaigns`, `read_marketing_events`
   - `read_online_store_pages`, `write_online_store_pages`
   - `read_content`, `write_content`
   - `read_products`, `write_products`
4. Click **Install app**
5. Copy the **Admin API access token**

To confirm what a token actually has, query `{ currentAppInstallation { accessScopes { handle } } }`.

### 2. Install

Run straight from npm — no clone, no build:

```bash
npx -y shopify-admin-mcp-server
```

Or install it globally:

```bash
npm install -g shopify-admin-mcp-server
```

<details>
<summary>From source</summary>

```bash
git clone <repo> shopify-admin-mcp-server
cd shopify-admin-mcp-server
npm install
npm run build
```

</details>

### 3. Configure the MCP client

```json
{
  "mcpServers": {
    "shopify": {
      "command": "npx",
      "args": ["-y", "shopify-admin-mcp-server"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "mystore.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

<details>
<summary>Running from a local build instead</summary>

```json
{
  "mcpServers": {
    "shopify": {
      "command": "node",
      "args": ["/full/path/to/shopify-admin-mcp-server/dist/index.js"],
      "env": {
        "SHOPIFY_STORE_DOMAIN": "mystore.myshopify.com",
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

</details>

### 4. Restart the client

---

## Environment Variables

| Variable | Required | Example |
|----------|----------|---------|
| `SHOPIFY_STORE_DOMAIN` | Yes | `mystore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | Yes | `shpat_abc123...` |

---

## Notes

- All GIDs use the format `gid://shopify/ResourceType/12345`
- Rate limits are handled automatically with retry-after backoff (up to 3 retries)
- Responses over 100,000 characters are truncated with a notice
- API version: **2026-01**
- `discountNodes` replaces `codeDiscountNodes` (removed in 2026-01)
- Destructive tools (`shopify_delete_product`, `shopify_delete_variants`) require an explicit `confirm: true`
- `inventoryAdjustQuantities` / `inventorySetQuantities` idempotency keys are optional until 2026-04, when they become required

## Fixed in v4.0.0

Five tools were silently broken against 2026-01 and failed on every call. All are now fixed and verified live:

| Tool | Bug |
|------|-----|
| `shopify_update_page` | Used non-existent `PageInput` type and `Page.bodyHtml` field |
| `shopify_adjust_inventory` | Selected `InventoryChange.inventoryItem`, which doesn't exist (it's `item`) |
| `shopify_get_page_by_id` | Selected `Page.seo`, which doesn't exist |
| `shopify_list_discounts` | Selected `DiscountRedeemCode.usageCount`, which doesn't exist (usage is `asyncUsageCount` on the discount) |
| `shopify_list_abandoned_checkouts` | Used four money fields that don't exist on `AbandonedCheckout` |

`productCreate` / `productUpdate` were also migrated off the deprecated `input: ProductInput!` argument to `product: ProductCreateInput` / `ProductUpdateInput`.
