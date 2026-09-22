/**
 * Customer + tagging tools.
 *
 * Scopes: read_customers (+ write access on the tagged resource type)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MONEY_FRAGMENT,
  READ_ONLY,
  WRITE_SAFE,
  checkUserErrors,
  err,
  ok,
  shopifyGraphQL,
} from "../shopify-client.js";

// ─── GraphQL: Customers ──────────────────────────────────────────────────────

const CUSTOMERS_QUERY = `
  query GetCustomers($first: Int!, $query: String, $after: String) {
    customers(first: $first, query: $query, after: $after) {
      edges {
        node {
          id firstName lastName email phone state tags
          numberOfOrders amountSpent { amount currencyCode }
          createdAt updatedAt
          defaultAddress { address1 city province country zip phone }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CUSTOMER_BY_ID_QUERY = `
  query GetCustomerById($id: ID!) {
    customer(id: $id) {
      id firstName lastName email phone state tags
      numberOfOrders amountSpent { amount currencyCode }
      createdAt updatedAt
      defaultAddress { address1 address2 city province country zip phone }
      addresses { address1 address2 city province country zip phone }
      orders(first: 5, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id name createdAt displayFinancialStatus
            totalPriceSet { ${MONEY_FRAGMENT} }
          }
        }
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation AddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation RemoveTags($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { message }
    }
  }
`;

// ─── Registration ────────────────────────────────────────────────────────────

export function registerCustomerTools(server: McpServer): void {
  // ═════════════════════════════════════════════════════════════════════════
  // CUSTOMER TOOLS  (read_customers)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_search_customers",
    {
      title: "Search Shopify Customers",
      description: `Search customers by name, email, tags, or any Shopify customer query filter.

Example queries: "Jane Smith", "email:bob@example.com", "tag:vip", "state:enabled"`,
      inputSchema: {
        query: z.string().optional().describe("Search query"),
        limit: z.number().int().min(1).max(250).default(20),
        after: z.string().optional().describe("Pagination cursor"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          customers: { edges: Array<{ node: Record<string, unknown> }>; pageInfo: { hasNextPage: boolean; endCursor: string } };
        }>(CUSTOMERS_QUERY, { first: params.limit, query: params.query ?? null, after: params.after ?? null });
        return ok({
          count: data.customers.edges.length,
          has_more: data.customers.pageInfo.hasNextPage,
          next_cursor: data.customers.pageInfo.endCursor,
          customers: data.customers.edges.map((e) => e.node),
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_customer",
    {
      title: "Get Shopify Customer by ID",
      description: `Full customer profile: all addresses, tags, order history (last 5 orders), and lifetime spend.`,
      inputSchema: {
        customerId: z.string().min(1).describe("Customer GID e.g. gid://shopify/Customer/1234567890"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ customer: Record<string, unknown> | null }>(CUSTOMER_BY_ID_QUERY, { id: params.customerId });
        if (!data.customer) throw new Error(`Customer ${params.customerId} not found`);
        return ok({ customer: data.customer });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_add_tags",
    {
      title: "Add Tags to Shopify Resource",
      description: `Add tags to any Shopify resource you have write access to (products, articles, collections). Tags are additive — existing tags are preserved.

Note: requires write access on the target resource type (e.g. write_products for products).`,
      inputSchema: {
        id: z.string().min(1).describe("Resource GID (product, collection, article, etc.)"),
        tags: z.array(z.string()).min(1).describe("Tags to add"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ tagsAdd: { node: { id: string }; userErrors: Array<{ message: string }> } }>(
          TAGS_ADD_MUTATION, { id: params.id, tags: params.tags }
        );
        checkUserErrors(data.tagsAdd.userErrors, "add tags");
        return ok({ success: true, id: data.tagsAdd.node.id, tags_added: params.tags });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_remove_tags",
    {
      title: "Remove Tags from Shopify Resource",
      description: `Remove specific tags from any Shopify resource you have write access to (products, articles, collections).`,
      inputSchema: {
        id: z.string().min(1).describe("Resource GID"),
        tags: z.array(z.string()).min(1).describe("Tags to remove"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ tagsRemove: { node: { id: string }; userErrors: Array<{ message: string }> } }>(
          TAGS_REMOVE_MUTATION, { id: params.id, tags: params.tags }
        );
        checkUserErrors(data.tagsRemove.userErrors, "remove tags");
        return ok({ success: true, id: data.tagsRemove.node.id, tags_removed: params.tags });
      } catch (error) { return err(error); }
    }
  );
}
