import type { SearchResult, Env } from '../types';
import { DEFAULT_TIMEOUT_MS } from '../constants';

const BOCHA_BASE_URL = 'https://api.bochaai.com/v1';

interface BochaWebResult {
  name: string;
  url: string;
  snippet: string;
  summary?: string;
  siteName?: string;
  datePublished?: string;
  displayUrl?: string;
}

interface BochaResponse {
  code: number;
  data?: {
    webPages?: {
      value: BochaWebResult[];
      totalEstimatedMatches?: number;
    };
  };
  msg?: string;
}

export async function searchBocha(
  query: string,
  limit: number,
  env: Env,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${BOCHA_BASE_URL}/web-search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.BOCHA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        count: Math.min(limit * 2, 20), // request more for filtering headroom
        freshness: 'noLimit',
        summary: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Bocha API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as BochaResponse;

    if (data.code !== 200 || !data.data?.webPages?.value) {
      throw new Error(data.msg || 'Bocha returned no results');
    }

    return data.data.webPages.value.slice(0, limit).map((item): SearchResult => ({
      title: item.name,
      url: item.url,
      snippet: item.snippet || '',
      source: 'bocha',
      siteName: item.siteName,
      summary: item.summary,
      publishedDate: item.datePublished,
      quality: 'green' as const,
      score: 0, // scored later by scorer
    }));
  } finally {
    clearTimeout(timer);
  }
}

export async function searchBochaAI(
  query: string,
  limit: number,
  env: Env,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<{ results: SearchResult[]; answer?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${BOCHA_BASE_URL}/ai-search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.BOCHA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        count: Math.min(limit * 2, 20),
        freshness: 'noLimit',
        answer: true,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Bocha AI API error: ${response.status}`);
    }

    const data = await response.json() as BochaResponse & { data?: { answer?: string; webPages?: { value: BochaWebResult[] } } };

    const results: SearchResult[] = (data.data?.webPages?.value ?? []).slice(0, limit).map((item): SearchResult => ({
      title: item.name,
      url: item.url,
      snippet: item.snippet || '',
      source: 'bocha',
      siteName: item.siteName,
      summary: item.summary,
      publishedDate: item.datePublished,
      quality: 'green' as const,
      score: 0,
    }));

    return { results, answer: data.data?.answer };
  } finally {
    clearTimeout(timer);
  }
}
