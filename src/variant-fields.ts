/**
 * Shared variant field handling for single and bulk writes.
 *
 * Shopify splits a variant's data across two input types: variant-level fields
 * live on ProductVariantsBulkInput, while cost, customs and weight live on a
 * nested InventoryItemInput. Callers should not have to care, so this module
 * takes one flat object and produces the nested shape Shopify expects.
 */

/** Weight units accepted by InventoryItemMeasurementInput. */
export type WeightUnit = "GRAMS" | "KILOGRAMS" | "OUNCES" | "POUNDS";

/** Every field the bulk tool can set. `sku` is deliberately absent — see the design doc. */
export interface VariantFieldInput {
  // Variant level
  price?: string;
  compareAtPrice?: string;
  barcode?: string;
  taxable?: boolean;
  taxCode?: string;
  inventoryPolicy?: "DENY" | "CONTINUE";
  // Inventory item level
  cost?: string;
  tracked?: boolean;
  requiresShipping?: boolean;
  harmonizedSystemCode?: string;
  countryCodeOfOrigin?: string;
  provinceCodeOfOrigin?: string;
  countryHarmonizedSystemCodes?: Array<{ countryCode: string; harmonizedSystemCode: string }>;
  weightValue?: number;
  weightUnit?: WeightUnit;
}

/**
 * Strip the dots and spaces merchants copy out of tariff schedules, then check the
 * result is a plausible HS/HTS code — 6 digits internationally, extended to 8, 10 or
 * 13 by national schedules.
 */
export function normaliseHsCode(raw: string, field: string): string {
  const digits = raw.replace(/[\s.\-]/g, "");
  if (!/^\d{6,13}$/.test(digits)) {
    throw new Error(
      `${field}: "${raw}" is not a valid HS/HTS code. Expected 6 to 13 digits ` +
      `(dots, spaces and dashes are ignored), e.g. '611020' or '6110.20.20'.`
    );
  }
  return digits;
}

/** Shopify's CountryCode enum is uppercase; accept any casing from the caller. */
export function normaliseCountryCode(raw: string, field: string): string {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new Error(`${field}: "${raw}" is not a 2-letter ISO country code, e.g. 'AU' or 'CN'.`);
  }
  return code;
}

/** True when the payload changes storefront-visible pricing. Drives the dry-run default. */
export function touchesPrice(fields: VariantFieldInput): boolean {
  return fields.price !== undefined || fields.compareAtPrice !== undefined;
}

/** Flat caller-facing fields → the nested ProductVariantsBulkInput Shopify expects. */
export function buildVariantInput(
  variantId: string,
  fields: VariantFieldInput
): Record<string, unknown> {
  const variant: Record<string, unknown> = { id: variantId };
  const item: Record<string, unknown> = {};

  if (fields.price !== undefined) variant.price = fields.price;
  if (fields.compareAtPrice !== undefined) variant.compareAtPrice = fields.compareAtPrice;
  if (fields.barcode !== undefined) variant.barcode = fields.barcode;
  if (fields.taxable !== undefined) variant.taxable = fields.taxable;
  if (fields.taxCode !== undefined) variant.taxCode = fields.taxCode;
  if (fields.inventoryPolicy !== undefined) variant.inventoryPolicy = fields.inventoryPolicy;

  if (fields.cost !== undefined) item.cost = fields.cost;
  if (fields.tracked !== undefined) item.tracked = fields.tracked;
  if (fields.requiresShipping !== undefined) item.requiresShipping = fields.requiresShipping;
  if (fields.harmonizedSystemCode !== undefined) {
    item.harmonizedSystemCode = normaliseHsCode(fields.harmonizedSystemCode, "harmonizedSystemCode");
  }
  if (fields.countryCodeOfOrigin !== undefined) {
    item.countryCodeOfOrigin = normaliseCountryCode(fields.countryCodeOfOrigin, "countryCodeOfOrigin");
  }
  if (fields.provinceCodeOfOrigin !== undefined) {
    item.provinceCodeOfOrigin = fields.provinceCodeOfOrigin.trim().toUpperCase();
  }
  if (fields.countryHarmonizedSystemCodes !== undefined) {
    item.countryHarmonizedSystemCodes = fields.countryHarmonizedSystemCodes.map((c) => ({
      countryCode: normaliseCountryCode(c.countryCode, "countryHarmonizedSystemCodes.countryCode"),
      harmonizedSystemCode: normaliseHsCode(
        c.harmonizedSystemCode, "countryHarmonizedSystemCodes.harmonizedSystemCode"
      ),
    }));
  }
  if (fields.weightUnit !== undefined && fields.weightValue === undefined) {
    throw new Error("weightUnit requires weightValue — provide both or neither.");
  }
  if (fields.weightValue !== undefined) {
    item.measurement = {
      weight: { value: fields.weightValue, unit: fields.weightUnit ?? "KILOGRAMS" },
    };
  }

  if (Object.keys(item).length > 0) variant.inventoryItem = item;
  return variant;
}
