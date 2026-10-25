// Notion source. Used only when the DM presses Sync; showing images never
// talks to Notion, it reads the project cache.
//
// Privacy: we only read page titles, covers and image blocks. Data source
// queries and page retrievals use `filter_properties: ["title"]` (the title
// property's id is always "title"), so other properties are not even returned.
// `blocks.children.list` necessarily returns all top-level blocks of a page
// (the root page, its subpages, and database pages that have no cover); everything
// except image blocks and the ids of databases/subpages is dropped immediately
// and never stored.

import {
  APIErrorCode,
  Client,
  isFullBlock,
  isFullPage,
  isNotionClientError,
  iteratePaginatedAPI,
  LogLevel,
} from "@notionhq/client";
import { downloadImage } from "./download.ts";
import type { ImageSource, PlannedGroup, PlannedItem } from "./source.ts";

type Page = Extract<Awaited<ReturnType<Client["pages"]["retrieve"]>>, { properties: unknown }>;
type Block = Extract<
  Awaited<ReturnType<Client["blocks"]["children"]["list"]>>["results"][number],
  { type: string }
>;
type RichText = { plain_text: string }[];

function plain(rt: RichText | undefined): string {
  return (rt ?? []).map((t) => t.plain_text).join("").trim();
}

function pageTitle(page: Page): string {
  for (const p of Object.values(page.properties)) {
    if (p.type === "title") return plain(p.title);
  }
  return "";
}

function coverUrl(page: Page): string | null {
  const c = page.cover;
  if (!c) return null;
  if (c.type === "external") return c.external.url;
  if (c.type === "file") return c.file.url;
  return null;
}

function blockImageUrl(block: Block): string | null {
  if (block.type !== "image") return null;
  const img = block.image;
  if (img.type === "external") return img.external.url;
  if (img.type === "file") return img.file.url;
  return null;
}

/** Turn SDK errors into something the DM can act on. */
export function describeNotionError(e: unknown): string {
  if (isNotionClientError(e)) {
    switch (e.code) {
      case APIErrorCode.Unauthorized:
        return "401: invalid token. Paste the integration token again in Settings";
      case APIErrorCode.ObjectNotFound:
        return "404: no access. Connect the integration to the campaign page (••• → Connections)";
      case APIErrorCode.RestrictedResource:
        return "403: the integration has no read permission";
      case APIErrorCode.RateLimited:
        return "429: rate limited by Notion, try again later";
      default:
        return `${e.code}: ${e.message}`;
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch failed|unable to connect|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|proxy|timed? ?out/i.test(msg)) {
    return `cannot reach Notion, check the internet connection (${msg})`;
  }
  return msg;
}

export class NotionSource implements ImageSource {
  private readonly notion: Client;

  constructor(token: string) {
    // Default Notion-Version of SDK v5 is 2025-09-03 (data sources API).
    this.notion = new Client({ auth: token, timeoutMs: 60_000, logLevel: LogLevel.ERROR });
  }

  /** Title of a page, used as the default project name. */
  async titleOf(pageId: string): Promise<string> {
    return pageTitle(await this.retrievePage(pageId));
  }

  /** Check the token; returns the workspace name the integration belongs to. */
  async whoAmI(): Promise<string> {
    const me = await this.notion.users.me({});
    if (me.type === "bot") return me.bot.workspace_name || me.name || "Notion";
    return me.name || "Notion";
  }

  /**
   * Find every tab under the campaign root page:
   * - each database placed on the page (also inside columns) -> one tab per data source,
   *   one image per row (cover, or the first image on the row's page);
   * - images placed directly on the root page and on its subpages, plus the root
   *   cover -> one "Pages" tab.
   */
  async listGroups(rootPageId: string, log: (msg: string) => void): Promise<PlannedGroup[]> {
    const root = await this.retrievePage(rootPageId);
    const rootTitle = pageTitle(root) || "Image";
    const databases: string[] = [];
    const pages: string[] = [];
    const rootImages: Block[] = [];

    const scan = async (blockId: string, depth: number): Promise<void> => {
      for await (const block of iteratePaginatedAPI(this.notion.blocks.children.list, { block_id: blockId, page_size: 100 })) {
        if (!isFullBlock(block) || block.in_trash) continue;
        if (block.type === "child_database") databases.push(block.id);
        else if (block.type === "child_page") pages.push(block.id);
        else if (block.type === "image") rootImages.push(block);
        else if ((block.type === "column_list" || block.type === "column") && block.has_children && depth < 3) {
          await scan(block.id, depth + 1);
        }
      }
    };
    await scan(root.id, 0);

    const groups: PlannedGroup[] = [];
    for (const dbId of databases) {
      let db;
      try {
        db = await this.notion.databases.retrieve({ database_id: dbId });
      } catch (e) {
        // Linked views of databases that live elsewhere end up here; they are skipped.
        log(`  skipped database ${dbId}: ${describeNotionError(e)}`);
        continue;
      }
      const dbTitle = "title" in db ? plain(db.title) : "";
      const sources = "data_sources" in db ? db.data_sources : [];
      for (const ds of sources) {
        const label = sources.length > 1 ? [dbTitle, ds.name].filter(Boolean).join(" / ") : ds.name || dbTitle || "Database";
        groups.push({ id: `ds:${ds.id}`, label, list: () => this.listDataSource(ds.id) });
      }
    }

    groups.push({
      id: "pages",
      label: "Pages",
      hideIfEmpty: true,
      list: async () => {
        const out: PlannedItem[] = [];
        if (coverUrl(root)) out.push(this.coverItem(root, "Cover"));
        out.push(...this.imageItems(rootImages, root.id, rootTitle, log));
        for (const pageId of pages) out.push(...(await this.listPageImages(pageId, log)));
        return out;
      },
    });
    return groups;
  }

  private async retrievePage(pageId: string): Promise<Page> {
    const page = await this.notion.pages.retrieve({ page_id: pageId, filter_properties: ["title"] });
    if (!isFullPage(page)) throw new Error(`page ${pageId} is not accessible`);
    return page;
  }

  private coverItem(page: Page, label: string): PlannedItem {
    const url = coverUrl(page);
    return {
      id: page.id,
      label,
      sourcePageId: page.id,
      kind: "cover",
      lastEditedTime: page.last_edited_time,
      fetchImage: url ? () => downloadImage(url) : null,
    };
  }

  /** First top-level image block of a page, or null if there is none. */
  private async firstImageBlock(pageId: string): Promise<{ block: Block; url: string } | null> {
    for await (const block of iteratePaginatedAPI(this.notion.blocks.children.list, {
      block_id: pageId,
      page_size: 100,
    })) {
      if (!isFullBlock(block) || block.type !== "image" || block.in_trash) continue;
      const url = blockImageUrl(block);
      if (url) return { block, url };
    }
    return null;
  }

  /**
   * Cover of the page or, when the page has no cover, the first image placed
   * directly on the page (that is how most character/location pages are made).
   * The item id stays the page id either way, so it survives switching between the two.
   */
  private async pageImageItem(page: Page, label: string): Promise<PlannedItem> {
    const item = this.coverItem(page, label);
    if (item.fetchImage) return item;
    const found = await this.firstImageBlock(page.id);
    if (!found) return item;
    const { block, url } = found;
    return {
      ...item,
      kind: "block",
      // Block id + edit time: a new or edited image gets a new cache file name.
      lastEditedTime: `${block.id}@${block.last_edited_time}`,
      fetchImage: () => downloadImage(url),
    };
  }

  private async listDataSource(dataSourceId: string): Promise<PlannedItem[]> {
    const rows: Page[] = [];
    for await (const row of iteratePaginatedAPI(this.notion.dataSources.query, {
      data_source_id: dataSourceId,
      filter_properties: ["title"],
      page_size: 100,
    })) {
      if (!isFullPage(row)) continue; // skips partial objects and nested data sources
      if (row.in_trash) continue;
      rows.push(row);
    }
    // Pages without a cover need one extra request each; a few in flight at a time
    // stays under Notion's rate limit (about 3 requests per second on average).
    const out: PlannedItem[] = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i]!;
        out[i] = await this.pageImageItem(row, pageTitle(row) || "Untitled");
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker));
    out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    return out;
  }

  private imageItems(blocks: Block[], pageId: string, title: string, log: (msg: string) => void): PlannedItem[] {
    const out: PlannedItem[] = [];
    blocks.forEach((block, i) => {
      if (block.type !== "image") return;
      const url = blockImageUrl(block);
      if (!url) {
        log(`  skipped block ${block.id}: unknown image type`);
        return;
      }
      out.push({
        id: block.id,
        label: plain(block.image.caption) || `${title} ${i + 1}`,
        sourcePageId: pageId,
        kind: "block",
        lastEditedTime: block.last_edited_time,
        fetchImage: () => downloadImage(url),
      });
    });
    return out;
  }

  /** Images placed directly on a page (top level only). */
  private async listPageImages(pageId: string, log: (msg: string) => void): Promise<PlannedItem[]> {
    const page = await this.retrievePage(pageId);
    const images: Block[] = [];
    for await (const block of iteratePaginatedAPI(this.notion.blocks.children.list, { block_id: pageId, page_size: 100 })) {
      if (isFullBlock(block) && block.type === "image" && !block.in_trash) images.push(block);
    }
    return this.imageItems(images, page.id, pageTitle(page) || "Image", log);
  }
}

/** Accept a Notion page link (notion.so, app.notion.com, notion.site) or a bare id. */
export function parseNotionPageId(input: string): string | null {
  const text = input.trim().split(/[?#]/)[0] ?? "";
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text);
  if (uuid) return uuid[0].replace(/-/g, "").toLowerCase();
  const all = [...text.matchAll(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi)];
  return all.length ? all[all.length - 1]![0].toLowerCase() : null;
}
