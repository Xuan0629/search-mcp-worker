import type { Language, Intent, RouterResult } from './types';
import { ENGINE_REGISTRY } from './constants';
import { healthScore } from './engine-health';

// ---- Language Detection ----

const CJK_RANGES = [
  ['\u4e00', '\u9fff'],   // CJK Unified Ideographs
  ['\u3400', '\u4dbf'],   // CJK Unified Ideographs Extension A
  ['\uf900', '\ufaff'],   // CJK Compatibility Ideographs
];

function hasCJK(text: string): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    for (const ch of text) {
      if (ch.charCodeAt(0) >= lo.charCodeAt(0) && ch.charCodeAt(0) <= hi.charCodeAt(0)) return true;
    }
  }
  return false;
}

export function detectLanguage(query: string): Language {
  if (hasCJK(query)) return 'zh';
  return 'en';
}

// ---- Intent Classification ----

const ACADEMIC_KEYWORDS_EN = [
  'paper', 'research', 'study', 'arxiv', 'pubmed', 'journal',
  'thesis', 'dissertation', 'citation', 'abstract', 'doi',
  'conference', 'proceedings', 'preprint', 'algorithm', 'model',
  'neural network', 'transformer', 'deep learning', 'machine learning',
  'review paper', 'survey', 'empirical',
];

const ACADEMIC_KEYWORDS_ZH = [
  '论文', '研究', '学术', '期刊', '文献', '综述',
  '实验', '算法', '模型', '引用', '参考文献',
  '学位论文', '硕士', '博士',
];

const DEVELOPER_KEYWORDS_EN = [
  'github', 'npm', 'pypi', 'crate', 'package', 'library',
  'api', 'sdk', 'framework', 'install', 'pip install', 'npm install',
  'cargo', 'stack overflow', 'error', 'exception', 'debug',
  'compile', 'runtime', 'benchmark', 'repo', 'repository',
  'rust', 'python', 'javascript', 'typescript', 'go ', 'golang',
  'how to implement', 'code example', 'tutorial',
];

const DEVELOPER_KEYWORDS_ZH = [
  '安装', '编译', '报错', '调试', '源码', '框架',
  '库', '包', '接口', '示例代码', '教程',
  '实现', '部署', '运行时', 'npm', 'pip', 'cargo',
];

const NEWS_KEYWORDS_EN = [
  'news', 'breaking', 'headline', 'latest', 'today',
  'announce', 'release', 'launch', 'update', 'incident',
];

const NEWS_KEYWORDS_ZH = [
  '新闻', '最新', '今天', '发布', '宣布', '突发',
  '消息', '报道', '头条', '热点',
];

const REFERENCE_KEYWORDS_EN = [
  'what is', 'who is', 'define', 'definition', 'meaning',
  'wiki', 'encyclopedia', 'explain', 'concept', 'overview',
];

const REFERENCE_KEYWORDS_ZH = [
  '是什么', '什么是', '定义', '含义', '概念',
  '解释', '介绍', '百科', '概述', '简介',
];

export function classifyIntent(query: string, language: Language): Intent {
  const q = query.toLowerCase();
  const academicKW = language === 'zh' ? ACADEMIC_KEYWORDS_ZH : ACADEMIC_KEYWORDS_EN;
  const devKW = language === 'zh' ? DEVELOPER_KEYWORDS_ZH : DEVELOPER_KEYWORDS_EN;
  const newsKW = language === 'zh' ? NEWS_KEYWORDS_ZH : NEWS_KEYWORDS_EN;
  const refKW = language === 'zh' ? REFERENCE_KEYWORDS_ZH : REFERENCE_KEYWORDS_EN;

  // Score each intent
  const scores: Record<Intent, number> = {
    academic: countMatches(q, academicKW),
    developer: countMatches(q, devKW),
    news: countMatches(q, newsKW),
    reference: countMatches(q, refKW),
    general: 1, // baseline
  };

  // Return highest scoring intent
  let best: Intent = 'general';
  let bestScore = 1;
  for (const [intent, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = intent as Intent;
    }
  }

  return best;
}

function countMatches(query: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (query.includes(kw.toLowerCase())) count++;
  }
  return count;
}

// ---- Engine Selection ----

// Priority routing tables: [intent][language] → ordered engine names
const ROUTING_TABLE: Record<Intent, Record<Language, string[]>> = {
  general: {
    zh: ['bocha', 'baidu', 'bing_cn', 'sogou', 'duckduckgo', 'bing'],
    en: ['duckduckgo', 'bing', 'bocha', 'google'],
    any: ['duckduckgo', 'bing', 'bocha', 'google'],
  },
  academic: {
    zh: ['bocha', 'arxiv', 'pubmed', 'crossref', 'baidu', 'duckduckgo'],
    en: ['arxiv', 'pubmed', 'crossref', 'duckduckgo', 'bocha', 'bing'],
    any: ['arxiv', 'pubmed', 'crossref', 'duckduckgo', 'bocha'],
  },
  developer: {
    zh: ['bocha', 'github', 'stackexchange', 'npm', 'pypi', 'crates', 'baidu'],
    en: ['github', 'stackexchange', 'npm', 'pypi', 'crates', 'hackernews', 'duckduckgo', 'bocha'],
    any: ['github', 'stackexchange', 'npm', 'duckduckgo', 'bocha'],
  },
  news: {
    zh: ['bocha', 'baidu', 'bing_cn', 'sogou', 'duckduckgo'],
    en: ['duckduckgo', 'bing', 'bocha', 'hackernews'],
    any: ['duckduckgo', 'bing', 'bocha'],
  },
  reference: {
    zh: ['bocha', 'wikipedia', 'wikidata', 'ddg_instant', 'baidu'],
    en: ['wikipedia', 'wikidata', 'ddg_instant', 'duckduckgo', 'bocha'],
    any: ['wikipedia', 'wikidata', 'ddg_instant', 'duckduckgo'],
  },
};

export function selectEngines(intent: Intent, language: Language, disabledEngines?: ReadonlySet<string>): RouterResult {
  const engines = ROUTING_TABLE[intent]?.[language] ?? ROUTING_TABLE.general[language] ?? ROUTING_TABLE.general.any;

  // Filter to engines that exist in registry AND aren't in the disabled set
  const available = engines.filter(e => e in ENGINE_REGISTRY && !(disabledEngines?.has(e)));

  // Rank by health score so the race runs healthy engines first. Stable
  // sort: engines with no recorded events (cold start) keep their
  // declared priority slot, and ties keep declaration order. See
  // engine-health.ts healthScore() for the formula and analysis v2
  // §6.10 for the rationale.
  const ranked = rankByHealth(available);

  // Check if primary engine needs API key
  const primaryConfig = ENGINE_REGISTRY[ranked[0]];
  const confidence = primaryConfig ? (primaryConfig.requiresApiKey ? 0.9 : 0.95) : 0.7;

  return {
    engines: ranked,
    intent,
    language,
    confidence,
  };
}

/**
 * Stable-sort `engines` by health score (descending). Engines with no
 * recorded health events are treated as score 0 (neutral) so a fresh
 * engine doesn't get penalised below a warm-but-failing one.
 *
 * Stability is provided by Array.prototype.sort being stable in V8/JS
 * since ES2019, which is what CF Workers' runtime uses. Ties therefore
 * preserve the original ROUTING_TABLE declaration order.
 */
function rankByHealth(engines: string[]): string[] {
  const score = (e: string): number => healthScore(e) ?? 0;
  return [...engines].sort((a, b) => score(b) - score(a));
}

// ---- Main Router Entry ----

export function route(query: string, disabledEngines?: ReadonlySet<string>): RouterResult {
  const language = detectLanguage(query);
  const intent = classifyIntent(query, language);
  return selectEngines(intent, language, disabledEngines);
}

// ---- Batch: route for explicit engine list ----

export function routeExplicit(engines: string[], query: string, disabledEngines?: ReadonlySet<string>): RouterResult {
  const language = detectLanguage(query);
  const intent = classifyIntent(query, language);
  const available = engines.filter(e => e in ENGINE_REGISTRY && !(disabledEngines?.has(e)));
  const ranked = rankByHealth(available);
  return {
    engines: ranked.length > 0 ? ranked : ['duckduckgo'],
    intent,
    language,
    confidence: 0.6,
  };
}
