import type { SearchResult } from '../types';
import { ACADEMIC_TIMEOUT_MS } from '../constants';

// ---- arXiv ----

export async function searchArxiv(
  query: string,
  limit: number,
  timeout = ACADEMIC_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/atom+xml' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const xml = await response.text();

    return parseArxivXml(xml, limit);
  } catch {
    return [];
  }
}

function parseArxivXml(xml: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Parse Atom feed entries
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;

  while ((entryMatch = entryRegex.exec(xml)) !== null && results.length < limit) {
    const entry = entryMatch[1];

    const title = extractXmlTag(entry, 'title');
    const summary = extractXmlTag(entry, 'summary');
    const id = extractXmlTag(entry, 'id');
    const published = extractXmlTag(entry, 'published');

    if (title && id) {
      results.push({
        title: title.replace(/\s+/g, ' ').trim(),
        url: id.trim(),
        snippet: summary.replace(/\s+/g, ' ').trim().slice(0, 300),
        source: 'arxiv',
        publishedDate: published?.trim(),
        quality: 'green',
        score: 0,
      });
    }
  }

  return results;
}

// ---- PubMed ----

export async function searchPubMed(
  query: string,
  limit: number,
  timeout = ACADEMIC_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    // Step 1: Search for IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const searchResp = await fetch(searchUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!searchResp.ok) return [];
    const searchData = await searchResp.json() as any;
    const ids: string[] = searchData?.esearchresult?.idlist ?? [];

    if (ids.length === 0) return [];

    // Step 2: Fetch details
    const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), timeout);

    const summaryResp = await fetch(summaryUrl, { signal: controller2.signal });
    clearTimeout(timer2);

    if (!summaryResp.ok) return [];
    const summaryData = await summaryResp.json() as any;
    const result = summaryData?.result ?? {};

    return ids.map((id): SearchResult => {
      const item = result[id] ?? {};
      return {
        title: item.title || '',
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        snippet: (item.abstract || '').slice(0, 300),
        source: 'pubmed',
        publishedDate: item.pubdate || '',
        quality: 'green',
        score: 0,
      };
    });
  } catch {
    return [];
  }
}

// ---- CrossRef ----

export async function searchCrossRef(
  query: string,
  limit: number,
  timeout = ACADEMIC_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&sort=relevance`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    const items = data?.message?.items ?? [];
    return items.map((item: any): SearchResult => ({
      title: (item.title ?? [''])[0] || '',
      url: item.URL || (item.doi ? `https://doi.org/${item.doi}` : ''),
      snippet: (item.abstract || '').replace(/<[^>]+>/g, '').slice(0, 300),
      source: 'crossref',
      publishedDate: item.published?.['date-parts']?.[0]?.join('-') || '',
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ---- Helpers ----

function extractXmlTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? match[1] : '';
}
