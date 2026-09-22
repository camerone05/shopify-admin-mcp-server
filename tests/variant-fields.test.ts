import { describe, it, expect } from "vitest";
import {
  normaliseHsCode,
  normaliseCountryCode,
  touchesPrice,
  buildVariantInput,
} from "../src/variant-fields.js";

describe("normaliseHsCode", () => {
  it("accepts a bare 6-digit code", () => {
    expect(normaliseHsCode("611030", "hs")).toBe("611030");
  });

  it("strips dots, spaces and dashes from merchant-formatted codes", () => {
    expect(normaliseHsCode("6110.20.20", "hs")).toBe("61102020");
    expect(normaliseHsCode("6203 49 6030", "hs")).toBe("6203496030");
    expect(normaliseHsCode("6110-30", "hs")).toBe("611030");
  });

  it("rejects codes that are too short, too long, or non-numeric", () => {
    expect(() => normaliseHsCode("6110", "hs")).toThrow(/6 to 13 digits/);
    expect(() => normaliseHsCode("12345678901234", "hs")).toThrow(/6 to 13 digits/);
    expect(() => normaliseHsCode("61103X", "hs")).toThrow(/6 to 13 digits/);
  });

  it("names the offending field in the error", () => {
    expect(() => normaliseHsCode("nope", "myField")).toThrow(/myField/);
  });
});

describe("normaliseCountryCode", () => {
  it("uppercases and trims", () => {
    expect(normaliseCountryCode(" au ", "origin")).toBe("AU");
    expect(normaliseCountryCode("cn", "origin")).toBe("CN");
  });

  it("rejects anything that is not two letters", () => {
    expect(() => normaliseCountryCode("AUS", "origin")).toThrow(/2-letter/);
    expect(() => normaliseCountryCode("A1", "origin")).toThrow(/2-letter/);
    expect(() => normaliseCountryCode("", "origin")).toThrow(/2-letter/);
  });
});

describe("touchesPrice", () => {
  it("is true when price or compareAtPrice is present", () => {
    expect(touchesPrice({ price: "10.00" })).toBe(true);
    expect(touchesPrice({ compareAtPrice: "20.00" })).toBe(true);
  });

  it("is false for customs-only and cost-only payloads", () => {
    expect(touchesPrice({ harmonizedSystemCode: "611030" })).toBe(false);
    expect(touchesPrice({ cost: "12.50" })).toBe(false);
    expect(touchesPrice({})).toBe(false);
  });
});

describe("buildVariantInput", () => {
  it("puts variant-level fields at the top level", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/1", {
      price: "29.99",
      barcode: "9312345678907",
      inventoryPolicy: "DENY",
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/1",
      price: "29.99",
      barcode: "9312345678907",
      inventoryPolicy: "DENY",
    });
  });

  it("nests inventory-item fields and normalises customs values", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/2", {
      cost: "12.50",
      harmonizedSystemCode: "6110.30",
      countryCodeOfOrigin: "au",
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/2",
      inventoryItem: {
        cost: "12.50",
        harmonizedSystemCode: "611030",
        countryCodeOfOrigin: "AU",
      },
    });
  });

  it("maps weight into the measurement structure", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/3", {
      weightValue: 0.25,
      weightUnit: "KILOGRAMS",
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/3",
      inventoryItem: { measurement: { weight: { value: 0.25, unit: "KILOGRAMS" } } },
    });
  });

  it("throws when weightUnit is given without weightValue, instead of silently dropping it", () => {
    expect(() =>
      buildVariantInput("gid://shopify/ProductVariant/6", { weightUnit: "GRAMS" })
    ).toThrow(/weightUnit requires weightValue/);
  });

  it("defaults weightUnit to KILOGRAMS when weightValue is given alone", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/7", { weightValue: 0.5 });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/7",
      inventoryItem: { measurement: { weight: { value: 0.5, unit: "KILOGRAMS" } } },
    });
  });

  it("normalises every entry in countryHarmonizedSystemCodes", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/4", {
      countryHarmonizedSystemCodes: [{ countryCode: "us", harmonizedSystemCode: "6110.30.20.20" }],
    });
    expect(input).toEqual({
      id: "gid://shopify/ProductVariant/4",
      inventoryItem: {
        countryHarmonizedSystemCodes: [
          { countryCode: "US", harmonizedSystemCode: "6110302020" },
        ],
      },
    });
  });

  it("omits an empty inventoryItem rather than sending an empty object", () => {
    const input = buildVariantInput("gid://shopify/ProductVariant/5", { price: "1.00" });
    expect(input).not.toHaveProperty("inventoryItem");
  });
});
