// ============================================================
// HTTP Utilities — shared User-Agent + request helpers
// ============================================================
//
// Five HTML-scraping engines (bing, duckduckgo, baidu, sogou, google)
// each shipped their own 3-line randomUA() helper before this file
// existed. This is the one place to pick a User-Agent for outgoing
// requests.
//
// Picking randomly from the pool (instead of a single fixed UA)
// is the single most effective anti-fingerprinting trick we have at
// this layer: anti-bot systems often look for "every request from
// this IP uses the same UA string" as a strong worker signal, and
// rotating through 8 different strings breaks that pattern.

import { USER_AGENTS } from '../constants';

/** Pick a random User-Agent from the shared pool. */
export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}
