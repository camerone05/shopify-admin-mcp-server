import { describe, it, expect } from "vitest";
import { formatShopifyqlResponse } from "../src/tools/analytics.js";

describe("formatShopifyqlResponse", () => {
  it("throws when parseErrors is non-empty, rather than returning empty data", () => {
    expect(() =>
      formatShopifyqlResponse({
        shopifyqlQuery: { tableData: null, parseErrors: ["Unexpected token 'SHOWW'"] },
      })
    ).toThrow(/Unexpected token 'SHOWW'/);
  });

  it("includes every parse error in the message", () => {
    expect(() =>
      formatShopifyqlResponse({
        shopifyqlQuery: { tableData: null, parseErrors: ["first problem", "second problem"] },
      })
    ).toThrow(/first problem.*second problem/s);
  });

  it("returns columns and rows on success", () => {
    const result = formatShopifyqlResponse({
      shopifyqlQuery: {
        parseErrors: [],
        tableData: {
          columns: [
            { name: "month", dataType: "MONTH_TIMESTAMP", displayName: "Month" },
            { name: "total_sales", dataType: "MONEY", displayName: "Total sales" },
          ],
          rows: [{ month: "2026-06-01", total_sales: "70853.53" }],
        },
      },
    });
    expect(result).toEqual({
      columns: [
        { name: "month", type: "MONTH_TIMESTAMP", label: "Month" },
        { name: "total_sales", type: "MONEY", label: "Total sales" },
      ],
      rows: [{ month: "2026-06-01", total_sales: "70853.53" }],
      row_count: 1,
    });
  });

  it("treats a null tableData with no parse errors as an empty result", () => {
    const result = formatShopifyqlResponse({
      shopifyqlQuery: { tableData: null, parseErrors: [] },
    });
    expect(result).toEqual({ columns: [], rows: [], row_count: 0 });
  });
});
