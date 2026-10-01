import { XMLParser } from 'fast-xml-parser';

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
  categories: string[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === 'item' || name === 'category',
  parseTagValue: false,
  trimValues: true,
});

const asText = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

export function parseRss(xml: string): RssItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: Record<string, unknown>[] } } };
  const items = doc.rss?.channel?.item ?? [];
  return items.map((item) => ({
    title: asText(item.title),
    link: asText(item.link),
    description: asText(item.description),
    pubDate: asText(item.pubDate),
    guid: asText(item.guid),
    categories: ((item.category as unknown[] | undefined) ?? []).map(asText).filter(Boolean),
  }));
}
