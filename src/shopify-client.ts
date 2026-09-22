/**
 * Shared Shopify Admin GraphQL client, config, and MCP response helpers.
 *
 * Every tool module imports from here — this is the single place that knows
 * how to talk to Shopify and how to shape an MCP tool result.
 */

import axios, { AxiosError } from "axios";

// ─── Constants ───────────────────────────────────────────────────────────────

export const API_VERSION = "2026-01";
export const CHARACTER_LIMIT = 100000;
export const DEFAULT_LIMIT = 10;
export const MAX_ORDER_LIMIT = 250;
export const MAX_RETRIES = 3;

export const MONEY_FRAGMENT = `shopMoney { amount currencyCode }`;

// ─── Config (singleton, validated at startup) ────────────────────────────────

export interface Config {
  storeDomain: string;
  accessToken: string;
  graphqlUrl: string;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!storeDomain) {
    console.error("ERROR: SHOPIFY_STORE_DOMAIN environment variable is required");
    process.exit(1);
  }
  if (!accessToken) {
    console.error("ERROR: SHOPIFY_ACCESS_TOKEN environment variable is required");
    process.exit(1);
  }

  const domain = storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  _config = {
    storeDomain: domain,
    accessToken,
    graphqlUrl: `https://${domain}/admin/api/${API_VERSION}/graphql.json`,
  };
  return _config;
}

// ─── GraphQL client (retries on 429) ─────────────────────────────────────────

export async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
  retries = MAX_RETRIES
): Promise<T> {
  const { graphqlUrl, accessToken } = getConfig();

  try {
    const response = await axios.post(
      graphqlUrl,
      { query, variables },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        timeout: 30000,
      }
    );

    if (response.data.errors) {
      const msgs = response.data.errors.map((e: { message: string }) => e.message).join("; ");
      throw new Error(`Shopify GraphQL errors: ${msgs}`);
    }

    return response.data.data as T;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 429 && retries > 0) {
      const retryAfter = parseInt(error.response.headers["retry-after"] ?? "2", 10);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return shopifyGraphQL(query, variables, retries - 1);
    }
    throw error;
  }
}

// ─── Error handling ─────────────────────────────────────────────────────────

export function handleApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      switch (error.response.status) {
        case 401: return "Error: Authentication failed. Check your SHOPIFY_ACCESS_TOKEN.";
        case 402: return "Error: Store is frozen or payment required.";
        case 403: return "Error: Permission denied. Check your app's access scopes.";
        case 404: return "Error: Store not found. Check SHOPIFY_STORE_DOMAIN.";
        case 429: return "Error: Rate limit exceeded after retries. Try again shortly.";
        default:  return `Error: Shopify API status ${error.response.status}: ${JSON.stringify(error.response.data)}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. Reduce the date range or limit.";
    } else if (error.code === "ENOTFOUND") {
      return "Error: Could not resolve store domain. Check SHOPIFY_STORE_DOMAIN.";
    }
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: Unexpected error: ${String(error)}`;
}

export function checkUserErrors(
  errors: Array<{ field?: string | string[] | null; message: string; code?: string | null }> | undefined,
  context: string
): void {
  if (errors && errors.length > 0) {
    const detail = errors
      .map((e) => (e.code ? `${e.message} (${e.code})` : e.message))
      .join(", ");
    throw new Error(`Failed to ${context}: ${detail}`);
  }
}

// ─── Money & formatting helpers ──────────────────────────────────────────────

export interface MoneySet {
  shopMoney: { amount: string; currencyCode: string };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function money(set: MoneySet): number {
  return parseFloat(set.shopMoney.amount);
}

export function currency(set: MoneySet): string {
  return set.shopMoney.currencyCode;
}

export function buildDateQuery(dateFrom: string, dateTo: string, extra?: string): string {
  let q = `created_at:>=${dateFrom} created_at:<=${dateTo}`;
  if (extra) q += ` ${extra}`;
  return q;
}

/** Escape a value for safe interpolation into a Shopify search query string. */
export function quoteQueryValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ─── MCP response helpers ────────────────────────────────────────────────────

export function truncate(text: string): string {
  if (text.length > CHARACTER_LIMIT) {
    return (
      text.substring(0, CHARACTER_LIMIT) +
      `\n\n[TRUNCATED — response exceeded ${CHARACTER_LIMIT} chars. Use pagination or filters.]`
    );
  }
  return text;
}

export function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: truncate(JSON.stringify(data, null, 2)) }] };
}

/**
 * Serialize a list response, trimming the ITEM ARRAY (not the JSON string)
 * so the result always stays under CHARACTER_LIMIT and always parses as
 * valid JSON. Unlike ok()+truncate(), this never cuts mid-object — it
 * reports exactly how many items made it in vs how many matched, so the
 * caller knows to page/filter for the rest instead of silently losing data.
 */
export function okList<T>(
  itemsKey: string,
  items: T[],
  extra: Record<string, unknown> = {}
): { content: Array<{ type: "text"; text: string }> } {
  let count = items.length;
  const build = (n: number) =>
    JSON.stringify(
      { ...extra, [itemsKey]: items.slice(0, n), returned: n, of: items.length, truncated: n < items.length },
      null,
      2
    );

  let text = build(count);
  while (text.length > CHARACTER_LIMIT && count > 0) {
    count = Math.max(0, count - Math.ceil(count * 0.25) - 1);
    text = build(count);
  }
  return { content: [{ type: "text" as const, text }] };
}

export function err(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
}

// ─── Annotation presets ──────────────────────────────────────────────────────

export const READ_ONLY = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
} as const;

export const WRITE_SAFE = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true,
} as const;

export const WRITE_CREATE = {
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
} as const;

export const WRITE_DESTRUCTIVE = {
  readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
} as const;
