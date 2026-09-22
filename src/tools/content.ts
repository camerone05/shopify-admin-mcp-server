/**
 * Content tools — pages, blogs, articles, unified search, and metafields.
 *
 * Scopes: read_online_store_pages, write_online_store_pages, write_content,
 *         read_products (search)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  DEFAULT_LIMIT,
  shopifyGraphQL,
  checkUserErrors,
  ok,
  err,
  READ_ONLY,
  WRITE_SAFE,
  WRITE_CREATE,
  WRITE_DESTRUCTIVE,
} from "../shopify-client.js";

// ═══════════════════════════════════════════════════════════════════════════
// GRAPHQL QUERIES & MUTATIONS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Pages ───────────────────────────────────────────────────────────────────

const PAGES_QUERY = `
  query GetPages($first: Int!, $query: String) {
    pages(first: $first, query: $query) {
      edges {
        node { id title handle bodySummary createdAt updatedAt publishedAt }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PAGE_BY_ID_QUERY = `
  query GetPageById($id: ID!) {
    page(id: $id) {
      id title handle body bodySummary
      isPublished publishedAt createdAt updatedAt
      templateSuffix
    }
  }
`;

const PAGE_UPDATE_MUTATION = `
  mutation UpdatePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id title handle body isPublished updatedAt }
      userErrors { field message code }
    }
  }
`;

// ─── Blogs & Articles ────────────────────────────────────────────────────────

const BLOGS_QUERY = `
  query GetBlogs($first: Int!, $query: String) {
    blogs(first: $first, query: $query) {
      nodes { id handle title updatedAt commentPolicy createdAt templateSuffix tags }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const BLOG_BY_ID_QUERY = `
  query GetBlogById($id: ID!) {
    blog(id: $id) {
      id title handle templateSuffix commentPolicy createdAt updatedAt
      articles(first: 10) {
        nodes { id title handle publishedAt author { name } tags }
      }
    }
  }
`;

const BLOG_UPDATE_MUTATION = `
  mutation UpdateBlog($id: ID!, $blog: BlogUpdateInput!) {
    blogUpdate(id: $id, blog: $blog) {
      blog { id title handle templateSuffix commentPolicy }
      userErrors { field message }
    }
  }
`;

const ARTICLES_QUERY = `
  query GetArticles($blogId: ID!, $first: Int!) {
    blog(id: $blogId) {
      id title
      articles(first: $first) {
        edges {
          node {
            id title handle
            author { name }
            publishedAt tags
            image { id url altText }
            summary
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ARTICLE_BY_ID_QUERY = `
  query GetArticleById($id: ID!) {
    article(id: $id) {
      id title handle body summary tags publishedAt createdAt updatedAt
      author { name }
      blog { id title }
      image { id url altText width height }
    }
  }
`;

const ARTICLE_CREATE_MUTATION = `
  mutation CreateArticle($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id title handle body summary tags author { name } }
      userErrors { field message }
    }
  }
`;

const ARTICLE_UPDATE_MUTATION = `
  mutation UpdateArticle($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id title handle body summary tags author { name } image { id url altText } }
      userErrors { field message }
    }
  }
`;

// ─── Metafields ──────────────────────────────────────────────────────────────

const METAFIELDS_QUERY = `
  query GetMetafields($ownerId: ID!, $first: Int!, $namespace: String) {
    node(id: $ownerId) {
      id
      ... on HasMetafields {
        metafields(first: $first, namespace: $namespace) {
          edges { node { id namespace key value type updatedAt } }
        }
      }
    }
  }
`;

const METAFIELD_SET_MUTATION = `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value type }
      userErrors { field message }
    }
  }
`;

const METAFIELD_DELETE_MUTATION = `
  mutation DeleteMetafield($input: MetafieldDeleteInput!) {
    metafieldDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

// ═══════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

export function registerContentTools(server: McpServer): void {
  // ═════════════════════════════════════════════════════════════════════════
  // PAGE TOOLS  (read_online_store_pages, write_online_store_pages)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_get_pages",
    {
      title: "Get Shopify Pages",
      description: `List all store pages or search by title.`,
      inputSchema: {
        searchTitle: z.string().optional(),
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ pages: { edges: Array<{ node: Record<string, unknown> }> } }>(
          PAGES_QUERY, { first: params.limit, query: params.searchTitle ? `title:*${params.searchTitle}*` : undefined }
        );
        return ok({ pages: data.pages.edges.map((e) => e.node) });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_page_by_id",
    {
      title: "Get Shopify Page by ID",
      description: `Full page content including HTML body, SEO, and publish status. Use after shopify_get_pages to get the full body of a specific page.`,
      inputSchema: {
        pageId: z.string().min(1).describe("Page GID e.g. gid://shopify/Page/1234567890"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ page: Record<string, unknown> | null }>(PAGE_BY_ID_QUERY, { id: params.pageId });
        if (!data.page) throw new Error(`Page ${params.pageId} not found`);
        return ok({ page: data.page });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_update_page",
    {
      title: "Update Shopify Page",
      description: `Update a page's title, HTML body, handle, template suffix, and publish status. Only provided fields are changed.`,
      inputSchema: {
        pageId: z.string().min(1).describe("Page GID"),
        title: z.string().optional(),
        body: z.string().optional().describe("HTML body content"),
        isPublished: z.boolean().optional().describe("Publish or unpublish the page"),
        handle: z.string().optional(),
        templateSuffix: z.string().optional(),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const { pageId, ...pageFields } = params;
        const data = await shopifyGraphQL<{ pageUpdate: { page: Record<string, unknown>; userErrors: Array<{ field: string; message: string; code?: string }> } }>(
          PAGE_UPDATE_MUTATION, { id: pageId, page: pageFields }
        );
        checkUserErrors(data.pageUpdate.userErrors, "update page");
        return ok({ page: data.pageUpdate.page });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // BLOG TOOLS  (write_content)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_get_blogs",
    {
      title: "Get Shopify Blogs",
      description: `List all blogs or search by title.`,
      inputSchema: {
        searchTitle: z.string().optional(),
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ blogs: { nodes: Array<Record<string, unknown>> } }>(
          BLOGS_QUERY, { first: params.limit, query: params.searchTitle ? `title:*${params.searchTitle}*` : undefined }
        );
        return ok({ blogs: data.blogs.nodes });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_blog_by_id",
    {
      title: "Get Shopify Blog by ID",
      description: `Get a specific blog with its 10 most recent article summaries.`,
      inputSchema: {
        blogId: z.string().min(1).describe("Blog GID"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ blog: Record<string, unknown> }>(BLOG_BY_ID_QUERY, { id: params.blogId });
        return ok({ blog: data.blog });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_update_blog",
    {
      title: "Update Shopify Blog",
      description: `Update a blog's title, handle, template suffix, or comment policy.

Comment policies: MODERATED, AUTO_PUBLISHED, CLOSED`,
      inputSchema: {
        blogId: z.string().min(1).describe("Blog GID"),
        title: z.string().optional(),
        handle: z.string().optional(),
        templateSuffix: z.string().optional(),
        commentPolicy: z.enum(["MODERATED", "AUTO_PUBLISHED", "CLOSED"]).optional(),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const { blogId, ...updateData } = params;
        const data = await shopifyGraphQL<{ blogUpdate: { blog: Record<string, unknown>; userErrors: Array<{ field: string; message: string }> } }>(
          BLOG_UPDATE_MUTATION, { id: blogId, blog: updateData }
        );
        checkUserErrors(data.blogUpdate.userErrors, "update blog");
        return ok({ blog: data.blogUpdate.blog });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // ARTICLE TOOLS  (write_content)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_get_articles",
    {
      title: "Get Shopify Blog Articles",
      description: `Get articles from a specific blog. Use shopify_get_blogs first to find the blog GID.`,
      inputSchema: {
        blogId: z.string().min(1).describe("Blog GID"),
        limit: z.number().int().min(1).max(250).default(DEFAULT_LIMIT),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{
          blog: { id: string; title: string; articles: { edges: Array<{ node: Record<string, unknown> }>; pageInfo: Record<string, unknown> } };
        }>(ARTICLES_QUERY, { blogId: params.blogId, first: params.limit });
        return ok({ blogId: data.blog.id, blogTitle: data.blog.title, articles: data.blog.articles.edges.map((e) => e.node), pageInfo: data.blog.articles.pageInfo });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_get_article_by_id",
    {
      title: "Get Shopify Article by ID",
      description: `Full article with HTML body, SEO, author, tags, image, and parent blog reference.`,
      inputSchema: {
        articleId: z.string().min(1).describe("Article GID"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ article: Record<string, unknown> }>(ARTICLE_BY_ID_QUERY, { id: params.articleId });
        return ok({ article: data.article });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_create_article",
    {
      title: "Create Shopify Article",
      description: `Create a new blog article with HTML body, author, summary, and tags.`,
      inputSchema: {
        blogId: z.string().min(1).describe("Blog GID"),
        title: z.string().min(1),
        body: z.string().min(1).describe("HTML body content"),
        author: z.object({ name: z.string().min(1) }),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        published: z.boolean().optional().describe("Publish immediately (default false)"),
      },
      annotations: WRITE_CREATE,
    },
    async (params) => {
      try {
        const { blogId, body, published, ...rest } = params;
        const data = await shopifyGraphQL<{ articleCreate: { article: Record<string, unknown>; userErrors: Array<{ field: string; message: string }> } }>(
          ARTICLE_CREATE_MUTATION, { article: { blogId, body, isPublished: published, ...rest } }
        );
        checkUserErrors(data.articleCreate.userErrors, "create article");
        return ok({ article: data.articleCreate.article });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_update_article",
    {
      title: "Update Shopify Article",
      description: `Update an article's title, body, summary, tags, author, or publish status.`,
      inputSchema: {
        articleId: z.string().min(1).describe("Article GID"),
        title: z.string().optional(),
        body: z.string().optional().describe("HTML body"),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        author: z.object({ name: z.string() }).optional(),
        published: z.boolean().optional(),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const { articleId, published, ...updateData } = params;
        const data = await shopifyGraphQL<{ articleUpdate: { article: Record<string, unknown>; userErrors: Array<{ field: string; message: string }> } }>(
          ARTICLE_UPDATE_MUTATION, { id: articleId, article: { ...updateData, isPublished: published } }
        );
        checkUserErrors(data.articleUpdate.userErrors, "update article");
        return ok({ article: data.articleUpdate.article });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // SEARCH  (read_products, write_content, read_online_store_pages)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_search",
    {
      title: "Search Shopify Store",
      description: `Unified search across products, articles, blogs, and pages. Runs parallel queries for each type and returns results grouped by type.`,
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        types: z.array(z.enum(["ARTICLE", "BLOG", "PAGE", "PRODUCT"])).optional().describe("Types to search (default: all)"),
        limit: z.number().int().min(1).max(50).default(DEFAULT_LIMIT).describe("Results per type"),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const types = params.types ?? ["ARTICLE", "BLOG", "PAGE", "PRODUCT"];
        const typeQueries: Record<string, string> = {
          ARTICLE: `query($q: String!, $n: Int!) { articles(first: $n, query: $q) { nodes { id title handle summary blog { title } tags publishedAt } } }`,
          BLOG:    `query($q: String!, $n: Int!) { blogs(first: $n, query: $q) { nodes { id title handle commentPolicy } } }`,
          PAGE:    `query($q: String!, $n: Int!) { pages(first: $n, query: $q) { nodes { id title handle bodySummary publishedAt } } }`,
          PRODUCT: `query($q: String!, $n: Int!) { products(first: $n, query: $q) { nodes { id title handle status vendor totalInventory } } }`,
        };

        const results: Record<string, unknown[]> = {};
        await Promise.all(
          types.map(async (type) => {
            try {
              const data = await shopifyGraphQL<Record<string, { nodes: Array<Record<string, unknown>> }>>(
                typeQueries[type], { q: params.query, n: params.limit }
              );
              results[type.toLowerCase()] = data[type.toLowerCase() + "s"]?.nodes ?? [];
            } catch {
              results[type.toLowerCase()] = [];
            }
          })
        );

        return ok({ query: params.query, results });
      } catch (error) { return err(error); }
    }
  );

  // ═════════════════════════════════════════════════════════════════════════
  // METAFIELD TOOLS  (scoped to resources you can access)
  // ═════════════════════════════════════════════════════════════════════════

  server.registerTool(
    "shopify_get_metafields",
    {
      title: "Get Shopify Metafields",
      description: `Get metafields for any Shopify resource. Requires read access on the owner resource type (e.g. read_products for product metafields).`,
      inputSchema: {
        ownerId: z.string().min(1).describe("Owner GID (product, collection, customer, order, etc.)"),
        namespace: z.string().optional().describe("Filter by namespace"),
        limit: z.number().int().min(1).max(250).default(25),
      },
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ node: { id: string; metafields?: { edges: Array<{ node: Record<string, unknown> }> } } }>(
          METAFIELDS_QUERY, { ownerId: params.ownerId, first: params.limit, namespace: params.namespace ?? null }
        );
        const metafields = data.node?.metafields?.edges?.map((e) => e.node) ?? [];
        return ok({ ownerId: params.ownerId, count: metafields.length, metafields });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_set_metafield",
    {
      title: "Create/Update Shopify Metafield",
      description: `Upsert a metafield on any resource you have write access to (products, collections, pages, articles).

Common types: single_line_text_field, multi_line_text_field, integer, boolean, json, url, color, date, file_reference`,
      inputSchema: {
        ownerId: z.string().min(1).describe("Owner GID"),
        namespace: z.string().min(1),
        key: z.string().min(1),
        value: z.string().min(1),
        type: z.string().min(1).describe("Metafield type e.g. single_line_text_field, json"),
      },
      annotations: WRITE_SAFE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ metafieldsSet: { metafields: Array<Record<string, unknown>>; userErrors: Array<{ field: string; message: string }> } }>(
          METAFIELD_SET_MUTATION, { metafields: [{ ownerId: params.ownerId, namespace: params.namespace, key: params.key, value: params.value, type: params.type }] }
        );
        checkUserErrors(data.metafieldsSet.userErrors, "set metafield");
        return ok({ metafield: data.metafieldsSet.metafields[0] });
      } catch (error) { return err(error); }
    }
  );

  server.registerTool(
    "shopify_delete_metafield",
    {
      title: "Delete Shopify Metafield",
      description: `Delete a metafield by GID. Get the ID first with shopify_get_metafields.`,
      inputSchema: {
        metafieldId: z.string().min(1).describe("Metafield GID"),
      },
      annotations: WRITE_DESTRUCTIVE,
    },
    async (params) => {
      try {
        const data = await shopifyGraphQL<{ metafieldDelete: { deletedId: string; userErrors: Array<{ field: string; message: string }> } }>(
          METAFIELD_DELETE_MUTATION, { input: { id: params.metafieldId } }
        );
        checkUserErrors(data.metafieldDelete.userErrors, "delete metafield");
        return ok({ success: true, deletedId: data.metafieldDelete.deletedId });
      } catch (error) { return err(error); }
    }
  );
}
