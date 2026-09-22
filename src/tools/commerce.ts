/**
 * Commerce tools — collections, draft orders, discounts, abandoned checkouts.
 *
 * Scopes: read_products, write_products, read_draft_orders, read_discounts,
 *         read_checkouts
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_LIMIT,
  MONEY_FRAGMENT,
  shopifyGraphQL,
  checkUserErrors,
  ok,
  err,
  READ_ONLY,
  WRITE_SAFE,
  WRITE_CREATE,
  WRITE_DESTRUCTIVE,
} from "../shopify-client.js";

// ─── Collection writes ───────────────────────────────────────────────────────

const COLLECTION_CREATE_MUTATION = `
  mutation CreateCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title handle sortOrder seo { title description } }
      userErrors { field message }
    }
  }
`;

// collectionAddProductsV2 / collectionRemoveProducts run asynchronously and return a Job.
const COLLECTION_ADD_PRODUCTS_MUTATION = `
  mutation AddProductsToCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProductsV2(id: $id, productIds: $productIds) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const COLLECTION_REMOVE_PRODUCTS_MUTATION = `
  mutation RemoveProductsFromCollection($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      job { id done }
      userErrors { field message }
    }
  }
`;

// ═══════════════════════════════════════════════════════════════════════════
// GRAPHQL QUERIES & MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Collections ─────────────────────────────────────────────────────────────

const COLLECTIONS_QUERY = `
  query GetCollections($first: Int!, $query: String) {
    collections(first: $first, query: $query) {
      nodes {
        id handle title updatedAt sortOrder templateSuffix
        seo { title description }
      }
    }
  }
`;

const COLLECTION_UPDATE_MUTATION = `
  mutation UpdateCollection($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id title handle descriptionHtml updatedAt seo { title description } }
      userErrors { field message }
    }
  }
`;

// ─── Draft Orders ────────────────────────────────────────────────────────────

const DRAFT_ORDERS_QUERY = `
  query GetDraftOrders($first: Int!, $query: String, $after: String) {
    draftOrders(first: $first, query: $query, after: $after) {
      edges {
        node {
          id name status createdAt updatedAt
          totalPriceSet { ${MONEY_FRAGMENT} }
          subtotalPriceSet { ${MONEY_FRAGMENT} }
          customer { id displayName email }
          lineItems(first: 10) {
            edges { node { title quantity sku originalTotalSet { ${MONEY_FRAGMENT} } } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ─── Discounts (2026-01: discountNodes replaces deprecated codeDiscountNodes) ─

const DISCOUNTS_QUERY = `
  query GetDiscounts($first: Int!, $query: String, $after: String) {
    discountNodes(first: $first, query: $query, after: $after) {
      edges {
        node {
          id
          discount {
            ... on DiscountCodeBasic {
              title status startsAt endsAt usageLimit asyncUsageCount appliesOncePerCustomer
              codes(first: 5) { nodes { id code } }
              customerGets {
                value {
                  ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem }
                  ... on DiscountPercentage { percentage }
                }
              }
            }
            ... on DiscountCodeFreeShipping {
              title status startsAt endsAt usageLimit asyncUsageCount
              codes(first: 5) { nodes { id code } }
            }
            ... on DiscountCodeBxgy {
              title status startsAt endsAt usageLimit asyncUsageCount
              codes(first: 5) { nodes { id code } }
            }
            ... on DiscountAutomaticBasic {
              title status startsAt endsAt asyncUsageCount
              customerGets {
                value {
                  ... on DiscountAmount { amount { amount currencyCode } }
                  ... on DiscountPercentage { percentage }
                }
              }
            }
            ... on DiscountAutomaticBxgy {
              title status startsAt endsAt asyncUsageCount
            }
            ... on DiscountAutomaticFreeShipping {
              title status startsAt endsAt asyncUsageCount
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ─── Abandoned Checkouts ─────────────────────────────────────────────────────

const ABANDONED_CHECKOUTS_QUERY = `
  query GetAbandonedCheckouts($first: Int!, $after: String, $query: String) {
    abandonedCheckouts(first: $first, after: $after, query: $query) {
      nodes {
        id abandonedCheckoutUrl
        createdAt updatedAt completedAt
        totalPriceSet { ${MONEY_FRAGMENT} }
        subtotalPriceSet { ${MONEY_FRAGMENT} }
        totalTaxSet { ${MONEY_FRAGMENT} }
        totalLineItemsPriceSet { ${MONEY_FRAGMENT} }
        lineItems(first: 20) {
          nodes {
            title quantity sku variantTitle
            discountedTotalPriceSet { ${MONEY_FRAGMENT} }
          }
        }
        customer {
          id displayName firstName lastName
          defaultEmailAddress { emailAddress }
        }
        shippingAddress {
          address1 city province country zip
        }
        billingAddress {
          address1 city province country zip
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

export function registerCommerceTools(server: McpServer): void {
  // ═════════════════════════════════════════════════════════════════════════
  // COLLECTION TOOLS  (read_products, write_products)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_get_collections",
    {
      title: "Get Shopify Collections",
      description: `List all collections or search by title. Returns SEO fields, sort order, and template suffix.`,
      inputSchema: {
        searchTitle: z.string().optional(),
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ collections: { nodes: Array<Record<string, unknown>> } }>(
          COLLECTIONS_QUERY, { first: params.limit, query: params.searchTitle ? `title:*${params.searchTitle}*` : undefined }
        );
        return ok({ collections: data.collections.nodes });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_update_collection",
    {
      title: "Update Shopify Collection",
      description: `Update a collection's title, description HTML, and SEO metadata.`,
      inputSchema: {
        collectionId: z.string().min(1).describe("Collection GID"),
        title: z.string().optional(),
        description: z.string().optional(),
        descriptionHtml: z.string().optional(),
        seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const { collectionId, ...updateData } = params;
        const data = await shopifyGraphQL<{ collectionUpdate: { collection: Record<string, unknown>; userErrors: Array<{ field: string; message: string }> } }>(
          COLLECTION_UPDATE_MUTATION, { input: { id: collectionId, ...updateData } }
        );
        checkUserErrors(data.collectionUpdate.userErrors, "update collection");
        return ok({ collection: data.collectionUpdate.collection });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // DRAFT ORDER TOOLS  (read_draft_orders — read-only)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_list_draft_orders",
    {
      title: "List Shopify Draft Orders",
      description: `List draft orders with status, customer info, line items, and totals.

Filter examples: "status:open", "status:completed", "customer_id:gid://shopify/Customer/123"`,
      inputSchema: {
        query: z.string().optional().describe("Shopify query filter"),
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
        after: z.string().optional().describe("Pagination cursor"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          draftOrders: { edges: Array<{ node: Record<string, unknown> }>; pageInfo: { hasNextPage: boolean; endCursor: string } };
        }>(DRAFT_ORDERS_QUERY, { first: params.limit, query: params.query ?? null, after: params.after ?? null });
        return ok({
          count: data.draftOrders.edges.length,
          has_more: data.draftOrders.pageInfo.hasNextPage,
          next_cursor: data.draftOrders.pageInfo.endCursor,
          draft_orders: data.draftOrders.edges.map((e) => e.node),
        });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // DISCOUNT TOOLS  (read_discounts)
  // Uses discountNodes — codeDiscountNodes is deprecated in 2026-01
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_list_discounts",
    {
      title: "List Shopify Discounts",
      description: `List all discounts — code-based (basic, free shipping, BXGY) and automatic. Returns codes, usage counts, and discount values.

Filter by query string. Examples:
  - "status:ACTIVE"
  - "discount_type:percentage"
  - "discount_type:fixed_amount"
  - "title:SUMMER"`,
      inputSchema: {
        query: z.string().optional().describe("Filter e.g. 'status:ACTIVE' or 'discount_type:percentage'"),
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
        after: z.string().optional().describe("Pagination cursor"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          discountNodes: { edges: Array<{ node: Record<string, unknown> }>; pageInfo: { hasNextPage: boolean; endCursor: string } };
        }>(DISCOUNTS_QUERY, { first: params.limit, query: params.query ?? null, after: params.after ?? null });
        return ok({
          count: data.discountNodes.edges.length,
          has_more: data.discountNodes.pageInfo.hasNextPage,
          next_cursor: data.discountNodes.pageInfo.endCursor,
          discounts: data.discountNodes.edges.map((e) => e.node),
        });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // ABANDONED CHECKOUTS  (read_checkouts)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_list_abandoned_checkouts",
    {
      title: "List Abandoned Checkouts",
      description: `List abandoned checkouts with customer details, line items, pricing, and the recovery URL. Useful for identifying recovery opportunities and lost revenue.

Only returns checkouts that have not been completed (completedAt is null).`,
      inputSchema: {
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
        after: z.string().optional().describe("Pagination cursor"),
        query: z.string().optional().describe("Filter e.g. 'created_at:>2025-01-01'"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          abandonedCheckouts: {
            nodes: Array<Record<string, unknown>>;
            pageInfo: { hasNextPage: boolean; endCursor: string };
          };
        }>(ABANDONED_CHECKOUTS_QUERY, {
          first: params.limit,
          after: params.after ?? null,
          query: params.query ?? null,
        });
        return ok({
          count: data.abandonedCheckouts.nodes.length,
          has_more: data.abandonedCheckouts.pageInfo.hasNextPage,
          next_cursor: data.abandonedCheckouts.pageInfo.endCursor,
          abandoned_checkouts: data.abandonedCheckouts.nodes,
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_create_collection",
    {
      title: "Create Shopify Collection",
      description: `Create a collection.

Two kinds:
  - Manual (default): you choose the products, via shopify_collection_add_products.
  - Smart: pass ruleSet and Shopify keeps membership up to date automatically.
    e.g. { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "sale" }] }
    appliedDisjunctively: false = products must match ALL rules; true = ANY rule.
    Common columns: TAG, TITLE, TYPE, VENDOR, VARIANT_PRICE, VARIANT_INVENTORY.

A collection's rule set cannot be added later — decide smart vs manual now.`,
      inputSchema: {
        title: z.string().min(1),
        descriptionHtml: z.string().optional(),
        handle: z.string().optional(),
        seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
        sortOrder: z.enum([
          "MANUAL", "BEST_SELLING", "ALPHA_ASC", "ALPHA_DESC",
          "PRICE_DESC", "PRICE_ASC", "CREATED", "CREATED_DESC", "MUST_MATCH",
        ]).optional(),
        ruleSet: z.object({
          appliedDisjunctively: z.boolean().describe("false = match ALL rules, true = match ANY rule"),
          rules: z.array(z.object({
            column: z.string().describe("e.g. TAG, TITLE, TYPE, VENDOR, VARIANT_PRICE"),
            relation: z.string().describe("e.g. EQUALS, NOT_EQUALS, CONTAINS, GREATER_THAN, LESS_THAN"),
            condition: z.string().describe("The value to match against"),
          })).min(1),
        }).optional().describe("Provide to create a smart (automated) collection"),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          collectionCreate: {
            collection: Record<string, unknown> | null;
            userErrors: Array<{ field?: string[] | null; message: string }>;
          };
        }>(COLLECTION_CREATE_MUTATION, { input: params });
        checkUserErrors(data.collectionCreate.userErrors, "create collection");
        return ok({ collection: data.collectionCreate.collection });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_collection_add_products",
    {
      title: "Add Products to Collection",
      description: `Add products to a MANUAL collection.

This fails on smart (rule-based) collections — their membership is decided by the rules, not by hand.
Shopify processes the change asynchronously and returns a job; job.done: false just means it's still
running, not that it failed.`,
      inputSchema: {
        collectionId: z.string().min(1).describe("Collection GID"),
        productIds: z.array(z.string().min(1)).min(1).describe("Product GIDs to add"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          collectionAddProductsV2: {
            job: { id: string; done: boolean } | null;
            userErrors: Array<{ field?: string[] | null; message: string }>;
          };
        }>(COLLECTION_ADD_PRODUCTS_MUTATION, { id: params.collectionId, productIds: params.productIds });
        checkUserErrors(data.collectionAddProductsV2.userErrors, "add products to collection");
        return ok({
          success: true,
          added: params.productIds.length,
          job: data.collectionAddProductsV2.job,
          note: "Processed asynchronously — re-read the collection shortly to confirm.",
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_collection_remove_products",
    {
      title: "Remove Products from Collection",
      description: `Remove products from a MANUAL collection. The products themselves are not deleted — only their
membership of this collection.

Processed asynchronously, same as adding.`,
      inputSchema: {
        collectionId: z.string().min(1).describe("Collection GID"),
        productIds: z.array(z.string().min(1)).min(1).describe("Product GIDs to remove"),
      },
      annotations: WRITE_DESTRUCTIVE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          collectionRemoveProducts: {
            job: { id: string; done: boolean } | null;
            userErrors: Array<{ field?: string[] | null; message: string }>;
          };
        }>(COLLECTION_REMOVE_PRODUCTS_MUTATION, { id: params.collectionId, productIds: params.productIds });
        checkUserErrors(data.collectionRemoveProducts.userErrors, "remove products from collection");
        return ok({
          success: true,
          removed: params.productIds.length,
          job: data.collectionRemoveProducts.job,
          note: "Processed asynchronously — re-read the collection shortly to confirm.",
        });
      } catch (error) { return err(error); }
    }
  );
}
