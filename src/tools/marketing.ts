/**
 * Marketing events and customer activity timelines.
 *
 * Scopes used: read_marketing_events, read_customers.
 *
 * Both surfaces are frequently empty on stores without a connected marketing
 * integration. An empty result is a valid answer, not an error.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, okList, err, READ_ONLY } from "../shopify-client.js";
import { type GqlFn } from "../bulk.js";

export const MARKETING_EVENTS_QUERY = `
  query ListMarketingEvents($first: Int!, $cursor: String) {
    marketingEvents(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id type utmSource utmMedium utmCampaign sourceAndMedium startedAt endedAt
      }
    }
  }
`;

export const CUSTOMER_EVENTS_QUERY = `
  query CustomerEvents($id: ID!, $first: Int!) {
    customer(id: $id) {
      id displayName
      events(first: $first, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id message createdAt appTitle attributeToUser }
      }
    }
  }
`;

export interface MarketingEventNode {
  id: string;
  type: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  sourceAndMedium: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ListMarketingEventsParams {
  limit: number;
  after?: string;
}

/**
 * Core logic for shopify_list_marketing_events, extracted so it can be
 * unit tested with an injected gql. Returns the plain result payload;
 * the registered tool wraps it with okList()/err().
 */
export async function runListMarketingEvents(
  params: ListMarketingEventsParams,
  gql: GqlFn
): Promise<{ marketing_events: Array<Record<string, unknown>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> {
  const data = await gql<{
    marketingEvents: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: MarketingEventNode[];
    };
  }>(MARKETING_EVENTS_QUERY, { first: params.limit, cursor: params.after ?? null });

  return {
    marketing_events: data.marketingEvents.nodes.map(formatMarketingEvent),
    pageInfo: data.marketingEvents.pageInfo,
  };
}

export function formatMarketingEvent(node: MarketingEventNode): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    source_and_medium: node.sourceAndMedium,
    utm: { source: node.utmSource, medium: node.utmMedium, campaign: node.utmCampaign },
    started_at: node.startedAt,
    ended_at: node.endedAt,
  };
}

export function registerMarketingTools(server: McpServer): void {
  server.registerTool(
    "shopify_list_marketing_events",
    {
      title: "List Marketing Events",
      description: `Marketing events recorded against the store — ad campaigns, posts and other
attributed activity, with their UTM parameters and run dates.

Only populated when a marketing app or integration publishes events to Shopify. An empty list
means no such integration is connected, not that the query failed.`,
      inputSchema: {
        limit: z.number().int().min(1).max(250).default(50),
        after: z.string().optional().describe("Pagination cursor from a previous response's pageInfo.endCursor"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const result = await runListMarketingEvents(params, shopifyGraphQL);
        return okList("marketing_events", result.marketing_events, {
          pageInfo: result.pageInfo,
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_customer_events",
    {
      title: "Get Customer Activity Timeline",
      description: `The activity timeline for one customer — the same events Shopify shows on the
customer's admin page, newest first.

Many customers have no recorded events; an empty list is a valid answer.`,
      inputSchema: {
        customerId: z.string().min(1).describe("Customer GID e.g. gid://shopify/Customer/123"),
        limit: z.number().int().min(1).max(250).default(50),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          customer: {
            id: string;
            displayName: string;
            events: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<Record<string, unknown>>;
            };
          } | null;
        }>(CUSTOMER_EVENTS_QUERY, { id: params.customerId, first: params.limit });

        if (!data.customer) throw new Error(`Customer ${params.customerId} not found`);

        return okList("events", data.customer.events.nodes, {
          customer: { id: data.customer.id, name: data.customer.displayName },
          pageInfo: data.customer.events.pageInfo,
        });
      } catch (error) { return err(error); }
    }
  );
}
