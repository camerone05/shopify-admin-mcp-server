import { describe, it, expect, vi } from "vitest";
import { formatMarketingEvent, runListMarketingEvents } from "../src/tools/marketing.js";

describe("formatMarketingEvent", () => {
  it("flattens an event into snake_case output", () => {
    const result = formatMarketingEvent({
      id: "gid://shopify/MarketingEvent/1",
      type: "AD",
      utmSource: "facebook",
      utmMedium: "cpc",
      utmCampaign: "spring",
      sourceAndMedium: "facebook / cpc",
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: null,
    });
    expect(result).toEqual({
      id: "gid://shopify/MarketingEvent/1",
      type: "AD",
      source_and_medium: "facebook / cpc",
      utm: { source: "facebook", medium: "cpc", campaign: "spring" },
      started_at: "2026-06-01T00:00:00Z",
      ended_at: null,
    });
  });

  it("keeps nulls rather than inventing defaults", () => {
    const result = formatMarketingEvent({
      id: "gid://shopify/MarketingEvent/2",
      type: "POST",
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      sourceAndMedium: null,
      startedAt: "2026-06-01T00:00:00Z",
      endedAt: null,
    });
    expect(result.utm).toEqual({ source: null, medium: null, campaign: null });
    expect(result.source_and_medium).toBeNull();
  });
});

describe("runListMarketingEvents", () => {
  it("threads cursor parameter to GraphQL query", async () => {
    const mockGql = vi.fn().mockResolvedValue({
      marketingEvents: {
        pageInfo: { hasNextPage: true, endCursor: "CURSOR456" },
        nodes: [
          {
            id: "gid://shopify/MarketingEvent/10",
            type: "AD",
            utmSource: "google",
            utmMedium: "cpc",
            utmCampaign: "summer",
            sourceAndMedium: "google / cpc",
            startedAt: "2026-06-15T00:00:00Z",
            endedAt: null,
          },
        ],
      },
    });

    await runListMarketingEvents({ limit: 25, after: "CURSOR123" }, mockGql);

    expect(mockGql).toHaveBeenCalledWith(
      expect.stringContaining("query ListMarketingEvents"),
      { first: 25, cursor: "CURSOR123" }
    );
  });
});

