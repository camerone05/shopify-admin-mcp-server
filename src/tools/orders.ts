/**
 * Shop + Order tools.
 *
 * Scopes: read_orders, read_all_orders
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  MAX_ORDER_LIMIT,
  MONEY_FRAGMENT,
  READ_ONLY,
  buildDateQuery,
  currency,
  err,
  money,
  ok,
  round2,
  shopifyGraphQL,
  type MoneySet,
} from "../shopify-client.js";

// ─── GraphQL: Shop ───────────────────────────────────────────────────────────

const SHOP_QUERY = `
  query GetShop {
    shop {
      id name email myshopifyDomain
      primaryDomain { url host }
      plan { displayName partnerDevelopment shopifyPlus }
      billingAddress { address1 city province country zip }
      currencyCode weightUnit ianaTimezone
      taxesIncluded
      createdAt
      enabledPresentmentCurrencies
    }
  }
`;

// ─── GraphQL: Orders ─────────────────────────────────────────────────────────

const ORDER_FIELDS = `
  id name createdAt
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { ${MONEY_FRAGMENT} }
  subtotalPriceSet { ${MONEY_FRAGMENT} }
  totalShippingPriceSet { ${MONEY_FRAGMENT} }
  totalTaxSet { ${MONEY_FRAGMENT} }
  totalDiscountsSet { ${MONEY_FRAGMENT} }
  totalRefundedSet { ${MONEY_FRAGMENT} }
  note tags
  lineItems(first: 50) {
    edges {
      node {
        title quantity sku
        originalTotalSet { ${MONEY_FRAGMENT} }
        variant { id title }
      }
    }
  }
  customer {
    id displayName email firstName lastName numberOfOrders
  }
`;

const ORDERS_QUERY = `
  query GetOrders($query: String!, $first: Int!, $after: String) {
    orders(first: $first, query: $query, after: $after, sortKey: CREATED_AT) {
      edges { node { ${ORDER_FIELDS} } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ORDER_BY_ID_QUERY = `
  query GetOrderById($id: ID!) {
    order(id: $id) {
      ${ORDER_FIELDS}
      shippingAddress { address1 address2 city province country zip phone }
      billingAddress { address1 city province country zip }
      fulfillments {
        id status createdAt
        trackingInfo { company number url }
      }
      refunds {
        id createdAt
        totalRefundedSet { ${MONEY_FRAGMENT} }
      }
    }
  }
`;

const ORDER_COUNT_QUERY = `
  query GetOrderCount($query: String!) {
    ordersCount(query: $query) { count }
  }
`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  totalPriceSet: MoneySet;
  subtotalPriceSet: MoneySet;
  totalShippingPriceSet: MoneySet;
  totalTaxSet: MoneySet;
  totalDiscountsSet: MoneySet;
  totalRefundedSet: MoneySet;
  note: string | null;
  tags: string[];
  lineItems: { edges: Array<{ node: LineItemNode }> };
  customer: { id: string; displayName: string; email: string; firstName: string; lastName: string; numberOfOrders: string } | null;
}

interface LineItemNode {
  title: string;
  quantity: number;
  originalTotalSet: MoneySet;
  sku: string | null;
  variant: { id: string; title: string } | null;
}

interface OrdersResponse {
  orders: {
    edges: Array<{ node: OrderNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface OrderCountResponse {
  ordersCount: { count: number };
}

// ─── Shared formatter ────────────────────────────────────────────────────────

function formatOrder(o: OrderNode) {
  return {
    id: o.id, name: o.name, created_at: o.createdAt,
    financial_status: o.displayFinancialStatus, fulfillment_status: o.displayFulfillmentStatus,
    note: o.note, tags: o.tags,
    total_price: money(o.totalPriceSet), subtotal: money(o.subtotalPriceSet),
    shipping: money(o.totalShippingPriceSet), tax: money(o.totalTaxSet),
    discounts: money(o.totalDiscountsSet), refunded: money(o.totalRefundedSet),
    currency: currency(o.totalPriceSet),
    line_items: o.lineItems.edges.map((li) => ({
      title: li.node.title, quantity: li.node.quantity,
      total: money(li.node.originalTotalSet), sku: li.node.sku,
      variant: li.node.variant?.title ?? null,
    })),
    customer: o.customer ? {
      id: o.customer.id, name: o.customer.displayName, email: o.customer.email,
      total_orders: o.customer.numberOfOrders,
    } : null,
  };
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerOrderTools(server: McpServer): void {
  // ═════════════════════════════════════════════════════════════════════════
  // SHOP
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_get_shop",
    {
      title: "Get Shopify Shop Info",
      description: `Get store details: name, email, domain, Shopify plan, currency, timezone, billing address.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const data = await shopifyGraphQL<{ shop: Record<string, unknown> }>(SHOP_QUERY);
        return ok({ shop: data.shop });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // ORDER TOOLS  (read_orders, read_all_orders)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_list_orders",
    {
      title: "List Shopify Orders",
      description: `List orders within a date range with financial details, line items, and customer info.

Args:
  - date_from: Start date YYYY-MM-DD (inclusive)
  - date_to: End date YYYY-MM-DD (inclusive)
  - limit: Max orders 1–250 (default 50)
  - status_filter: Extra Shopify query filter e.g. "financial_status:paid fulfillment_status:unfulfilled"`,
      inputSchema: {
        date_from: z.string().describe("Start date YYYY-MM-DD"),
        date_to: z.string().describe("End date YYYY-MM-DD"),
        limit: z.number().int().min(1).max(MAX_ORDER_LIMIT).default(50).describe("Max orders (default 50)"),
        status_filter: z.string().optional().describe("Extra filter e.g. financial_status:paid"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const query = buildDateQuery(params.date_from, params.date_to, params.status_filter);
        const data = await shopifyGraphQL<OrdersResponse>(ORDERS_QUERY, { query, first: params.limit, after: null });
        const orders = data.orders.edges.map((e) => formatOrder(e.node));
        return ok({ date_range: { from: params.date_from, to: params.date_to }, count: orders.length, has_more: data.orders.pageInfo.hasNextPage, orders });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_order",
    {
      title: "Get Shopify Order by ID",
      description: `Get a single order by GID with full detail: line items, shipping/billing address, fulfillments, and refunds.`,
      inputSchema: {
        orderId: z.string().min(1).describe("Order GID e.g. gid://shopify/Order/1234567890"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ order: Record<string, unknown> | null }>(ORDER_BY_ID_QUERY, { id: params.orderId });
        if (!data.order) throw new Error(`Order ${params.orderId} not found`);
        return ok({ order: data.order });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_weekly_summary",
    {
      title: "Shopify Weekly Financial Summary",
      description: `Aggregate financial summary — fetches ALL orders in the period (auto-paginated), calculates revenue totals, AOV, items per order, and product breakdown sorted by revenue.`,
      inputSchema: {
        date_from: z.string().describe("Start date YYYY-MM-DD"),
        date_to: z.string().describe("End date YYYY-MM-DD"),
        status_filter: z.string().optional().describe("Extra filter e.g. financial_status:paid"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const query = buildDateQuery(params.date_from, params.date_to, params.status_filter);
        const countData = await shopifyGraphQL<OrderCountResponse>(ORDER_COUNT_QUERY, { query });

        const allOrders: OrderNode[] = [];
        let hasNextPage = true;
        let cursor: string | null = null;

        while (hasNextPage) {
          const pageData: OrdersResponse = await shopifyGraphQL<OrdersResponse>(ORDERS_QUERY, { query, first: MAX_ORDER_LIMIT, after: cursor });
          for (const edge of pageData.orders.edges) allOrders.push(edge.node);
          hasNextPage = pageData.orders.pageInfo.hasNextPage;
          cursor = pageData.orders.pageInfo.endCursor ?? null;
        }

        let totalRevenue = 0, totalSubtotal = 0, totalShipping = 0, totalTax = 0, totalDiscounts = 0, totalRefunded = 0, totalItems = 0;
        let cur = "AUD";
        const productMap = new Map<string, { quantity: number; revenue: number }>();

        for (const order of allOrders) {
          totalRevenue += money(order.totalPriceSet);
          totalSubtotal += money(order.subtotalPriceSet);
          totalShipping += money(order.totalShippingPriceSet);
          totalTax += money(order.totalTaxSet);
          totalDiscounts += money(order.totalDiscountsSet);
          totalRefunded += money(order.totalRefundedSet);
          cur = currency(order.totalPriceSet);
          for (const li of order.lineItems.edges) {
            const item = li.node;
            totalItems += item.quantity;
            const existing = productMap.get(item.title) ?? { quantity: 0, revenue: 0 };
            productMap.set(item.title, { quantity: existing.quantity + item.quantity, revenue: existing.revenue + money(item.originalTotalSet) });
          }
        }

        const orderCount = allOrders.length;
        const productBreakdown = Array.from(productMap.entries())
          .map(([title, d]) => ({ title, quantity: d.quantity, revenue: round2(d.revenue) }))
          .sort((a, b) => b.revenue - a.revenue);

        return ok({
          date_range: { from: params.date_from, to: params.date_to },
          currency: cur,
          orders: orderCount,
          total_orders_in_period: countData.ordersCount.count,
          total_items_sold: totalItems,
          items_per_order: round2(orderCount > 0 ? totalItems / orderCount : 0),
          revenue: {
            total_inc_tax: round2(totalRevenue), subtotal: round2(totalSubtotal),
            shipping: round2(totalShipping), tax: round2(totalTax),
            discounts: round2(totalDiscounts), refunded: round2(totalRefunded),
            net_revenue: round2(totalRevenue - totalRefunded),
          },
          average_order_value: round2(orderCount > 0 ? totalRevenue / orderCount : 0),
          product_breakdown: productBreakdown,
          top_products: productBreakdown.slice(0, 5),
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_order_count",
    {
      title: "Shopify Order Count",
      description: `Lightweight order count for a date range without fetching order details.`,
      inputSchema: {
        date_from: z.string().describe("Start date YYYY-MM-DD"),
        date_to: z.string().describe("End date YYYY-MM-DD"),
        status_filter: z.string().optional().describe("Extra filter e.g. financial_status:paid"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const query = buildDateQuery(params.date_from, params.date_to, params.status_filter);
        const data = await shopifyGraphQL<OrderCountResponse>(ORDER_COUNT_QUERY, { query });
        return ok({ date_range: { from: params.date_from, to: params.date_to }, count: data.ordersCount.count });
      } catch (error) { return err(error); }
    }
  );
}
