#!/usr/bin/env node
/**
 * Shopify MCP Server v4.0.0
 *
 * Shopify Admin GraphQL API 2026-01.
 *
 * Granted scopes on the current token (verified against the store):
 *   read_all_orders, read_orders, read_analytics, read_reports, read_customer_events,
 *   read_checkouts, read_customers, read_price_rules, read_discounts, read_draft_orders,
 *   read_inventory, write_inventory, read_inventory_transfers, write_inventory_transfers,
 *   read_locations, read_marketing_events, read_marketing_integrated_campaigns,
 *   read_online_store_pages, write_online_store_pages, read_content, write_content,
 *   read_products, write_products
 *
 * NOT granted (tools for these are deliberately absent — they would 403):
 *   write_orders, write_fulfillments, *_merchant_managed_fulfillment_orders, *_returns,
 *   write_draft_orders, write_discounts, write_customers, write_publications, write_locations
 *
 * Required environment variables:
 *   SHOPIFY_STORE_DOMAIN  — e.g. "mystore.myshopify.com"
 *   SHOPIFY_ACCESS_TOKEN  — Admin API access token
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { API_VERSION, getConfig } from "./shopify-client.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerProductTools } from "./tools/products.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerContentTools } from "./tools/content.js";
import { registerCommerceTools } from "./tools/commerce.js";
import { registerBulkVariantTools } from "./tools/bulk-variants.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerMarketingTools } from "./tools/marketing.js";

const VERSION = "4.0.0";

const server = new McpServer({
  name: "shopify-mcp-server",
  version: VERSION,
});

registerOrderTools(server);       // shop, orders, weekly summary, order count
registerCustomerTools(server);    // customers, resource tagging
registerProductTools(server);     // products, variants, media
registerInventoryTools(server);   // locations, variant⇄location activation, stock levels
registerContentTools(server);     // pages, blogs, articles, metafields, search
registerCommerceTools(server);    // collections, draft orders, discounts, abandoned checkouts
registerBulkVariantTools(server); // bulk variant field writes, customs coverage audit
registerAnalyticsTools(server);   // ShopifyQL
registerMarketingTools(server);   // marketing events, customer activity timelines

async function main() {
  const config = getConfig();
  console.error(`Shopify MCP Server v${VERSION} starting...`);
  console.error(`Store: ${config.storeDomain}`);
  console.error(`API:   ${API_VERSION}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running via stdio");
}

main().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
