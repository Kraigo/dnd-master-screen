// Notion source. Loaded only by `sync` (dynamic import), never by the running
// game server, so showing images never talks to Notion.
//
// Privacy: we only read page titles, covers and image blocks. Data source
// queries and page retrievals use `filter_properties: ["title"]` (the title
// property's id is always "title"), so other properties are not even returned.
// `blocks.children.list` necessarily returns all top-level blocks of a page
// (the city page, and data source pages that have no cover); everything except
// image blocks is dropped immediately and never stored.

import {
  APIErrorCode,
  Client,
  isFullBlock,
  isFullPage,
  isNotionClientError,
  iteratePaginatedAPI,
  LogLevel,
} from "@notionhq/client";
import type { GroupConfig, SourceConfig } from "../config.ts";
import { downloadImage } from "./download.ts";
import type { ImageSource, PlannedItem } from "./source.ts";

type Page = Extract<Awaited<ReturnType<Client["pages"]["retrieve"]>>, { properties: unknown }>;
type Block = Extract<
  Awaited<ReturnType<Client["blocks"]["children"]["list"]>>["results"][number],
  { type: string }
>;
type RichText = { plain_text: string }[];

function plain(rt: RichText | undefined): string {
  return (rt ?? []).map((t) => t.plain_text).join("").trim();
}

function pageTitle(page: Page, preferred?: string): string {
  const props = page.properties;
  const named = preferred ? props[preferred] : undefined;
  if (named?.type === "title") return plain(named.title);
  for (const p of Object.values(props)) {
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
        return "401: invalid token. Check NOTION_TOKEN in .env";
      case APIErrorCode.ObjectNotFound:
        return "404: no access. Connect the integration to the campaign root page (••• → Connections)";
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

  async listGroup(group: GroupConfig, log: (msg: string) => void): Promise<PlannedItem[]> {
    const items: PlannedItem[] = [];
    for (const source of group.sources) {
      items.push(...(await this.listSource(source, log)));
    }
    return items;
  }

  private async listSource(source: SourceConfig, log: (msg: string) => void): Promise<PlannedItem[]> {
    switch (source.type) {
      case "dataSource":
        return this.listDataSource(source.dataSourceId, source.titleProperty);
      case "pageImages":
        return this.listPageImages(source.pageId, log);
      case "pageCover":
        return this.listPageCover(source.pageId, source.label);
    }
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

  private async listDataSource(dataSourceId: string, titleProperty?: string): Promise<PlannedItem[]> {
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
        out[i] = await this.pageImageItem(row, pageTitle(row, titleProperty) || "Untitled");
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, worker));
    out.sort((a, b) => a.label.localeCompare(b.label, "ru"));
    return out;
  }

  private async listPageCover(pageId: string, label?: string): Promise<PlannedItem[]> {
    const page = await this.retrievePage(pageId);
    return [this.coverItem(page, label || pageTitle(page) || "Cover")];
  }

  private async listPageImages(pageId: string, log: (msg: string) => void): Promise<PlannedItem[]> {
    const page = await this.retrievePage(pageId);
    const title = pageTitle(page) || "Image";
    const out: PlannedItem[] = [];
    let n = 0;
    for await (const block of iteratePaginatedAPI(this.notion.blocks.children.list, {
      block_id: pageId,
      page_size: 100,
    })) {
      if (!isFullBlock(block) || block.type !== "image" || block.in_trash) continue;
      n += 1;
      const url = blockImageUrl(block);
      if (!url) {
        log(`  skipped block ${block.id}: unknown image type`);
        continue;
      }
      out.push({
        id: block.id,
        label: plain(block.image.caption) || `${title} ${n}`,
        sourcePageId: page.id,
        kind: "block",
        lastEditedTime: block.last_edited_time,
        fetchImage: () => downloadImage(url),
      });
    }
    return out;
  }
}
