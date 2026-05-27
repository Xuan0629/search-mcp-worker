import type { SearchResult } from '../types';
import { DEFAULT_TIMEOUT_MS } from '../constants';

// ---- Wikipedia ----

export async function searchWikipedia(
  query: string,
  limit: number,
  language = 'en',
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const baseUrl = language === 'zh'
      ? 'https://zh.wikipedia.org/w/api.php'
      : 'https://en.wikipedia.org/w/api.php';

    const url = `${baseUrl}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&utf8=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    const langPrefix = language === 'zh' ? 'zh' : 'en';
    return (data?.query?.search ?? []).map((item: any): SearchResult => ({
      title: item.title,
      url: `https://${langPrefix}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: (item.snippet || '').replace(/<[^>]+>/g, '').trim(),
      source: 'wikipedia',
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ---- Wikidata ----

export async function searchWikidata(
  query: string,
  limit: number,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&limit=${limit}&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    return (data?.search ?? []).map((item: any): SearchResult => ({
      title: item.label || item.id,
      url: item.concepturi || `https://www.wikidata.org/wiki/${item.id}`,
      snippet: item.description || '',
      source: 'wikidata',
      quality: 'green',
      score: 0,
    }));
  } catch {
    return [];
  }
}

// ---- DDG Instant Answer ----

export async function searchDDGInstantAnswer(
  query: string,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return [];
    const data = await response.json() as any;

    const results: SearchResult[] = [];

    // Main answer
    if (data.Abstract) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL || '',
        snippet: data.Abstract,
        source: 'ddg_instant',
        quality: 'green',
        score: 0,
      });
    }

    // Related topics
    for (const topic of (data.RelatedTopics ?? []).slice(0, 4)) {
      if (topic.text && topic.FirstURL) {
        results.push({
          title: topic.text.slice(0, 80),
          url: topic.FirstURL,
          snippet: topic.text,
          source: 'ddg_instant',
          quality: 'green',
          score: 0,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}
