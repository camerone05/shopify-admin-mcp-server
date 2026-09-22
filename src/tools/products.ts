/**
 * Product, variant, and media tools.
 *
 * Scopes used: read_products, write_products.
 *
 * Note on 2026-01: productCreate/productUpdate take `product:` (ProductCreateInput /
 * ProductUpdateInput). The older `input: ProductInput!` argument is deprecated, and
 * ProductInput no longer carries variants — variants are managed through the
 * productVariantsBulk* mutations instead.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  shopifyGraphQL, checkUserErrors, ok, okList, err, DEFAULT_LIMIT,
  READ_ONLY, WRITE_SAFE, WRITE_CREATE, WRITE_DESTRUCTIVE,
} from "../shopify-client.js";

// ─── GraphQL ─────────────────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query GetProducts($first: Int, $last: Int, $after: String, $before: String, $query: String, $reverse: Boolean) {
    products(first: $first, last: $last, after: $after, before: $before, query: $query, reverse: $reverse) {
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      edges {
        cursor
        node {
          id title handle status vendor productType tags
          createdAt updatedAt totalInventory
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
          images(first: 1) { edges { node { url altText } } }
          variants(first: 10) {
            edges {
              node {
                id title price compareAtPrice inventoryQuantity sku
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

/** Lean listing — no variants/images/pricing. Use for bulk scans, filters, and tagging. */
const PRODUCTS_SUMMARY_QUERY = `
  query GetProductsSummary($first: Int, $last: Int, $after: String, $before: String, $query: String, $reverse: Boolean) {
    products(first: $first, last: $last, after: $after, before: $before, query: $query, reverse: $reverse) {
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      edges {
        cursor
        node { id title handle status vendor productType tags totalInventory }
      }
    }
  }
`;

/** Lean product-id + tags listing, paged internally by shopify_bulk_tag_products. */
const BULK_TAG_IDS_QUERY = `
  query GetProductIdsForTagging($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      edges { node { id title tags } }
    }
  }
`;

const BULK_TAGS_ADD_MUTATION = `
  mutation BulkAddTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { message }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `
  query GetProductById($id: ID!) {
    product(id: $id) {
      id title description descriptionHtml handle status vendor productType tags
      createdAt updatedAt totalInventory
      seo { title description }
      options { id name position optionValues { id name } }
      priceRangeV2 {
        minVariantPrice { amount currencyCode }
        maxVariantPrice { amount currencyCode }
      }
      media(first: 20) {
        nodes {
          id alt mediaContentType status
          ... on MediaImage { image { url width height } }
        }
      }
      variants(first: 100) {
        edges {
          node {
            id title price compareAtPrice inventoryQuantity sku barcode
            inventoryItem { id }
            selectedOptions { name value }
          }
        }
      }
      collections(first: 10) { edges { node { id title } } }
    }
  }
`;

const PRODUCT_CREATE_MUTATION = `
  mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id title handle status vendor productType tags
        seo { title description }
        options { id name optionValues { id name } }
        variants(first: 10) { nodes { id title sku price } }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `
  mutation UpdateProduct($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product {
        id title handle status vendor productType tags updatedAt
        seo { title description }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_DELETE_MUTATION = `
  mutation DeleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

const PRODUCT_DUPLICATE_MUTATION = `
  mutation DuplicateProduct($productId: ID!, $newTitle: String!, $includeImages: Boolean, $newStatus: ProductStatus) {
    productDuplicate(productId: $productId, newTitle: $newTitle, includeImages: $includeImages, newStatus: $newStatus) {
      newProduct { id title handle status }
      userErrors { field message }
    }
  }
`;

const PRODUCT_MEDIA_ADD_MUTATION = `
  mutation AddProductMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product {
        id title
        media(first: 20) {
          nodes {
            id alt mediaContentType status
            ... on MediaImage { image { url width height } }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

const VARIANT_BULK_CREATE_MUTATION = `
  mutation BulkCreateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants {
        id title sku price
        selectedOptions { name value }
        inventoryItem { id sku }
      }
      userErrors { field message }
    }
  }
`;

const VARIANT_BULK_UPDATE_MUTATION = `
  mutation UpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id title price compareAtPrice barcode inventoryQuantity inventoryPolicy
        inventoryItem { id sku }
      }
      userErrors { field message }
    }
  }
`;

const VARIANT_BULK_DELETE_MUTATION = `
  mutation BulkDeleteVariants($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id title }
      userErrors { field message }
    }
  }
`;

// ─── Shared shapes ───────────────────────────────────────────────────────────

type UserErrors = Array<{ field?: string[] | null; message: string }>;

const seoSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
}).optional();

/** ProductVariantsBulkInput nests sku under inventoryItem; keep sku flat for callers. */
function mapVariantInput<T extends { sku?: string }>(v: T) {
  const { sku, ...rest } = v;
  return { ...rest, ...(sku !== undefined ? { inventoryItem: { sku } } : {}) };
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerProductTools(server: McpServer): void {
  server.registerTool(
    "shopify_get_products",
    {
      title: "Get Shopify Products",
      description: `List or search products. Supports cursor pagination.

Args:
  - searchTitle: Partial title match
  - query: Raw Shopify filter e.g. "status:active vendor:Nike tag:sale"
  - limit: Max results (default 10)
  - after/before: Pagination cursors
  - detail: "full" (variants, inventory, pricing, SKUs, images — default) or "summary"
    (id/title/handle/status/vendor/productType/tags/totalInventory only — much lighter,
    use this for bulk scans, filtering, or deciding what to tag)`,
      inputSchema: {
        searchTitle: z.string().optional().describe("Filter by title (partial match)"),
        query: z.string().optional().describe("Raw Shopify query e.g. 'status:active vendor:Nike'"),
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
        after: z.string().optional().describe("Cursor for next page"),
        before: z.string().optional().describe("Cursor for previous page"),
        reverse: z.boolean().default(false).describe("Reverse sort order"),
        detail: z.enum(["full", "summary"]).default("full")
          .describe("summary = id/title/status/vendor/productType/tags/totalInventory only, no variants/images/pricing"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        let queryStr: string | undefined;
        if (params.query) queryStr = params.query;
        else if (params.searchTitle) queryStr = `title:*${params.searchTitle}*`;

        type ProductsData = {
          products: {
            pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string; endCursor: string };
            edges: Array<{ cursor: string; node: Record<string, unknown> }>;
          };
        };
        const gqlQuery = params.detail === "summary" ? PRODUCTS_SUMMARY_QUERY : PRODUCTS_QUERY;
        const data = await shopifyGraphQL<ProductsData>(gqlQuery, {
          first: params.before ? undefined : params.limit,
          last: params.before ? params.limit : undefined,
          after: params.after, before: params.before,
          query: queryStr, reverse: params.reverse,
        });

        const products = data.products.edges.map((edge) => {
          const p = edge.node;

          if (params.detail === "summary") {
            return {
              id: p.id, title: p.title, handle: p.handle,
              status: p.status, vendor: p.vendor, productType: p.productType,
              tags: p.tags, totalInventory: p.totalInventory, cursor: edge.cursor,
            };
          }

          const variants = ((p.variants as Record<string, unknown>)?.edges as Array<{ node: Record<string, unknown> }>)?.map((ve) => ({
            id: ve.node.id, title: ve.node.title, price: ve.node.price, compareAtPrice: ve.node.compareAtPrice,
            inventoryQuantity: ve.node.inventoryQuantity, sku: ve.node.sku, options: ve.node.selectedOptions,
          })) ?? [];
          const images = ((p.images as Record<string, unknown>)?.edges as Array<{ node: Record<string, unknown> }>) ?? [];
          const pr = p.priceRangeV2 as Record<string, Record<string, string>> | undefined;
          return {
            id: p.id, title: p.title, handle: p.handle,
            status: p.status, vendor: p.vendor, productType: p.productType,
            tags: p.tags, createdAt: p.createdAt, updatedAt: p.updatedAt, totalInventory: p.totalInventory,
            priceRange: pr ? { min: pr.minVariantPrice, max: pr.maxVariantPrice } : null,
            imageUrl: images[0] ? (images[0].node as Record<string, unknown>).url : null,
            variants, cursor: edge.cursor,
          };
        });

        return okList("products", products, { pageInfo: data.products.pageInfo });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_bulk_tag_products",
    {
      title: "Bulk Add Tags to Matching Products",
      description: `Add tags to every product matching a Shopify search query, paging through all matches
server-side in one call — no manual pagination or per-product tagging round trips.

Example: query: "title:*jersey* OR title:*bib* OR title:*t-shirt*", tags: ["reviewsizing"]

Skips products that already carry every tag given. Set dryRun:true to preview the match set
(and see which products would be skipped as already-tagged) before writing anything.`,
      inputSchema: {
        query: z.string().min(1).describe('Shopify product search query, e.g. "title:*jersey* OR title:*bib*"'),
        tags: z.array(z.string().min(1)).min(1).describe("Tags to add to every matching product"),
        dryRun: z.boolean().default(false).describe("If true, report matches without writing any tags"),
        maxProducts: z.number().int().min(1).max(2000).default(500)
          .describe("Safety cap on how many products a single call will touch"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const matched: Array<{ id: string; title: string; alreadyTagged: boolean }> = [];
        let after: string | undefined;
        let hasNext = true;

        while (hasNext && matched.length < params.maxProducts) {
          const data = await shopifyGraphQL<{
            products: {
              pageInfo: { hasNextPage: boolean; endCursor: string };
              edges: Array<{ node: { id: string; title: string; tags: string[] } }>;
            };
          }>(BULK_TAG_IDS_QUERY, { first: 100, after, query: params.query });

          for (const edge of data.products.edges) {
            if (matched.length >= params.maxProducts) break;
            matched.push({
              id: edge.node.id,
              title: edge.node.title,
              alreadyTagged: params.tags.every((t) => edge.node.tags.includes(t)),
            });
          }
          hasNext = data.products.pageInfo.hasNextPage;
          after = data.products.pageInfo.endCursor;
        }

        const toTag = matched.filter((m) => !m.alreadyTagged);

        if (!params.dryRun) {
          for (const m of toTag) {
            const res = await shopifyGraphQL<{ tagsAdd: { userErrors: UserErrors } }>(
              BULK_TAGS_ADD_MUTATION, { id: m.id, tags: params.tags }
            );
            checkUserErrors(res.tagsAdd.userErrors, `tag product "${m.title}"`);
          }
        }

        return ok({
          matched: matched.length,
          already_tagged: matched.length - toTag.length,
          tagged: params.dryRun ? 0 : toTag.length,
          dry_run: params.dryRun,
          hit_max_products_cap: matched.length >= params.maxProducts,
          products: matched.map((m) => ({
            id: m.id,
            title: m.title,
            action: m.alreadyTagged ? "skipped (already tagged)" : params.dryRun ? "would tag" : "tagged",
          })),
        });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_product_by_id",
    {
      title: "Get Shopify Product by ID",
      description: `Full product detail: all variants with inventory item IDs, product options, media, collections, and SEO fields.`,
      inputSchema: {
        productId: z.string().min(1).describe("Product GID e.g. gid://shopify/Product/1234567890"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ product: Record<string, unknown> | null }>(
          PRODUCT_BY_ID_QUERY, { id: params.productId }
        );
        if (!data.product) throw new Error(`Product ${params.productId} not found`);
        return ok({ product: data.product });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_create_product",
    {
      title: "Create Shopify Product",
      description: `Create a product. Defaults to DRAFT status — pass status: "ACTIVE" to publish immediately.

Options and variants:
  - Give productOptions (e.g. Size → S/M/L) to create a product with real variants.
  - Then call shopify_create_variants to add the priced variants against those options.
  - With no productOptions, Shopify creates a single default variant; set its price with shopify_update_product.

Images can be attached at creation via imageUrls (each must be a publicly reachable URL).`,
      inputSchema: {
        title: z.string().min(1),
        descriptionHtml: z.string().optional(),
        status: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).default("DRAFT"),
        vendor: z.string().optional(),
        productType: z.string().optional(),
        tags: z.array(z.string()).optional(),
        handle: z.string().optional(),
        seo: seoSchema,
        productOptions: z.array(z.object({
          name: z.string().min(1).describe("Option name e.g. 'Size'"),
          values: z.array(z.string().min(1)).min(1).describe("Option values e.g. ['S','M','L']"),
        })).optional().describe("Product options — required if the product has real variants"),
        imageUrls: z.array(z.string().url()).optional().describe("Publicly reachable image URLs to attach"),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const { productOptions, imageUrls, ...productFields } = params;

        const product = {
          ...productFields,
          ...(productOptions
            ? { productOptions: productOptions.map((o) => ({ name: o.name, values: o.values.map((v) => ({ name: v })) })) }
            : {}),
        };
        const media = imageUrls?.map((url) => ({ originalSource: url, mediaContentType: "IMAGE" as const }));

        const data = await shopifyGraphQL<{
          productCreate: { product: Record<string, unknown>; userErrors: UserErrors };
        }>(PRODUCT_CREATE_MUTATION, { product, media: media ?? null });
        checkUserErrors(data.productCreate.userErrors, "create product");
        return ok({ product: data.productCreate.product });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_update_product",
    {
      title: "Update Shopify Product",
      description: `Update a product's title, description, SEO, status, vendor, tags, or its variants' prices/SKUs.
Only provided fields change.

Variants passed here are UPDATED (each needs its variant GID). To add new variants use shopify_create_variants;
to remove them use shopify_delete_variants.`,
      inputSchema: {
        productId: z.string().min(1).describe("Product GID"),
        title: z.string().optional(),
        descriptionHtml: z.string().optional(),
        seo: seoSchema,
        status: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).optional(),
        vendor: z.string().optional(),
        productType: z.string().optional(),
        tags: z.array(z.string()).optional(),
        handle: z.string().optional(),
        variants: z.array(z.object({
          id: z.string().describe("Variant GID (required)"),
          price: z.string().optional(),
          compareAtPrice: z.string().optional(),
          sku: z.string().optional(),
          barcode: z.string().optional(),
          inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional(),
        })).optional(),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const { productId, variants, ...productFields } = params;

        const response = await shopifyGraphQL<{
          productUpdate: { product: Record<string, unknown>; userErrors: UserErrors };
        }>(PRODUCT_UPDATE_MUTATION, { product: { id: productId, ...productFields }, media: null });
        checkUserErrors(response.productUpdate.userErrors, "update product");

        if (variants && variants.length > 0) {
          const vResponse = await shopifyGraphQL<{
            productVariantsBulkUpdate: { productVariants: unknown[]; userErrors: UserErrors };
          }>(VARIANT_BULK_UPDATE_MUTATION, { productId, variants: variants.map(mapVariantInput) });
          checkUserErrors(vResponse.productVariantsBulkUpdate.userErrors, "update variants");
        }

        const refetch = await shopifyGraphQL<{ product: Record<string, unknown> | null }>(
          PRODUCT_BY_ID_QUERY, { id: productId }
        );
        return ok({ product: refetch.product });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_delete_product",
    {
      title: "Delete Shopify Product",
      description: `PERMANENTLY delete a product and all its variants, media, inventory items, and collection memberships.
This CANNOT be undone.

Prefer setting status to ARCHIVED via shopify_update_product if there is any chance you'll want it back.
Completed orders containing the product are unaffected.`,
      inputSchema: {
        productId: z.string().min(1).describe("Product GID"),
        confirm: z.literal(true).describe("Must be true — confirms this permanent deletion is intended"),
      },
      annotations: WRITE_DESTRUCTIVE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          productDelete: { deletedProductId: string | null; userErrors: UserErrors };
        }>(PRODUCT_DELETE_MUTATION, { input: { id: params.productId } });
        checkUserErrors(data.productDelete.userErrors, "delete product");
        return ok({ success: true, deletedProductId: data.productDelete.deletedProductId });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_duplicate_product",
    {
      title: "Duplicate Shopify Product",
      description: `Copy a product, including its variants and options, under a new title.
The copy defaults to DRAFT so it can't accidentally go live.`,
      inputSchema: {
        productId: z.string().min(1).describe("Product GID to copy"),
        newTitle: z.string().min(1).describe("Title for the copy"),
        includeImages: z.boolean().default(true),
        newStatus: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).default("DRAFT"),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          productDuplicate: { newProduct: Record<string, unknown> | null; userErrors: UserErrors };
        }>(PRODUCT_DUPLICATE_MUTATION, params);
        checkUserErrors(data.productDuplicate.userErrors, "duplicate product");
        return ok({ product: data.productDuplicate.newProduct });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_add_product_media",
    {
      title: "Add Media to Shopify Product",
      description: `Attach images or video to a product from publicly reachable URLs.

Shopify fetches each URL asynchronously, so media comes back with status UPLOADED/PROCESSING and becomes
READY shortly after. A URL Shopify cannot reach fails silently into a FAILED status — re-read the product
with shopify_get_product_by_id to confirm.`,
      inputSchema: {
        productId: z.string().min(1).describe("Product GID"),
        media: z.array(z.object({
          url: z.string().url().describe("Publicly reachable media URL"),
          alt: z.string().optional().describe("Alt text — worth setting for SEO and accessibility"),
          type: z.enum(["IMAGE", "VIDEO", "EXTERNAL_VIDEO", "MODEL_3D"]).default("IMAGE"),
        })).min(1),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          productUpdate: { product: Record<string, unknown> | null; userErrors: UserErrors };
        }>(PRODUCT_MEDIA_ADD_MUTATION, {
          product: { id: params.productId },
          media: params.media.map((m) => ({
            originalSource: m.url,
            mediaContentType: m.type,
            ...(m.alt ? { alt: m.alt } : {}),
          })),
        });
        checkUserErrors(data.productUpdate.userErrors, "add product media");
        return ok({ success: true, product: data.productUpdate.product });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_create_variants",
    {
      title: "Create Product Variants",
      description: `Add new variants to an existing product.

Each variant must supply optionValues matching the product's options — e.g. for a product with options
Size and Colour: optionValues: [{ optionName: "Size", name: "M" }, { optionName: "Colour", name: "Black" }].
Read the product's options first with shopify_get_product_by_id.

strategy REMOVE_STANDALONE_VARIANT deletes the auto-created default variant — use it when adding the
first real variants to a product that was created without options.`,
      inputSchema: {
        productId: z.string().min(1).describe("Product GID"),
        variants: z.array(z.object({
          price: z.string().describe("Price e.g. '29.99'"),
          compareAtPrice: z.string().optional(),
          sku: z.string().optional(),
          barcode: z.string().optional(),
          inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional(),
          optionValues: z.array(z.object({
            optionName: z.string().describe("Existing product option name e.g. 'Size'"),
            name: z.string().describe("Value for that option e.g. 'M'"),
          })).min(1),
        })).min(1),
        strategy: z.enum(["DEFAULT", "REMOVE_STANDALONE_VARIANT"]).default("DEFAULT"),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          productVariantsBulkCreate: { productVariants: unknown[]; userErrors: UserErrors };
        }>(VARIANT_BULK_CREATE_MUTATION, {
          productId: params.productId,
          variants: params.variants.map(mapVariantInput),
          strategy: params.strategy,
        });
        checkUserErrors(data.productVariantsBulkCreate.userErrors, "create variants");
        return ok({ success: true, variants: data.productVariantsBulkCreate.productVariants });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_delete_variants",
    {
      title: "Delete Product Variants",
      description: `PERMANENTLY delete variants from a product, along with their inventory items. This CANNOT be undone.

A product must keep at least one variant — deleting all of them fails.`,
      inputSchema: {
        productId: z.string().min(1).describe("Product GID"),
        variantIds: z.array(z.string().min(1)).min(1).describe("Variant GIDs to delete"),
        confirm: z.literal(true).describe("Must be true — confirms this permanent deletion is intended"),
      },
      annotations: WRITE_DESTRUCTIVE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          productVariantsBulkDelete: { product: Record<string, unknown> | null; userErrors: UserErrors };
        }>(VARIANT_BULK_DELETE_MUTATION, { productId: params.productId, variantsIds: params.variantIds });
        checkUserErrors(data.productVariantsBulkDelete.userErrors, "delete variants");
        return ok({
          success: true,
          deleted: params.variantIds.length,
          product: data.productVariantsBulkDelete.product,
        });
      } catch (error) { return err(error); }
    }
  );
}
