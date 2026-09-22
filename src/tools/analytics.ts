/**
 * ShopifyQL analytics.
 *
 * Scopes used: read_reports (plus Level 2 protected customer data access).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, ok, err, READ_ONLY } from "../shopify-client.js";

export const SHOPIFYQL_QUERY = `
  query RunShopifyql($query: String!) {
    shopifyqlQuery(query: $query) {
      tableData {
        columns { name dataType displayName }
        rows
      }
      parseErrors
    }
  }
`;

export interface ShopifyqlResponse {
  shopifyqlQuery: {
    parseErrors: string[];
    tableData: {
      columns: Array<{ name: string; dataType: string; displayName: string }>;
      rows: Array<Record<string, unknown>>;
    } | null;
  };
}

/**
 * A malformed ShopifyQL query returns HTTP 200 with parseErrors populated and
 * tableData null. Passing that through verbatim reads as "the store has no
 * sales", so parse errors are promoted to a thrown error instead.
 */
export function formatShopifyqlResponse(response: ShopifyqlResponse): Record<string, unknown> {
  const { parseErrors, tableData } = response.shopifyqlQuery;

  if (parseErrors && parseErrors.length > 0) {
    throw new Error(`ShopifyQL could not parse the query: ${parseErrors.join("; ")}`);
  }
  if (!tableData) {
    return { columns: [], rows: [], row_count: 0 };
  }

  return {
    columns: tableData.columns.map((c) => ({
      name: c.name, type: c.dataType, label: c.displayName,
    })),
    rows: tableData.rows,
    row_count: tableData.rows.length,
  };
}

export function registerAnalyticsTools(server: McpServer): void {
  server.registerTool(
    "shopify_analytics_query",
    {
      title: "Query Store Analytics (ShopifyQL)",
      description: `Run a ShopifyQL query against the store's analytics and get back a table.

ShopifyQL shape: FROM <dataset> SHOW <metrics> [GROUP BY <dimension>] [SINCE <range>] [UNTIL <range>]
[ORDER BY <column>] [LIMIT n]

Datasets include sales, orders, products, customers.

Examples:
  FROM sales SHOW total_sales GROUP BY month SINCE -12m ORDER BY month
  FROM sales SHOW total_sales, orders GROUP BY product_title SINCE -30d ORDER BY total_sales DESC LIMIT 10
  FROM orders SHOW average_order_value SINCE -90d

A syntax error is reported as an error, not as an empty table — an empty result genuinely means
no matching data.`,
      inputSchema: {
        query: z.string().min(1).describe("ShopifyQL query, e.g. 'FROM sales SHOW total_sales SINCE -30d'"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<ShopifyqlResponse>(SHOPIFYQL_QUERY, { query: params.query });
        return ok({ query: params.query, ...formatShopifyqlResponse(data) });
      } catch (error) { return err(error); }
    }
  );
}
