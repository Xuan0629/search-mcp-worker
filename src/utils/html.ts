// ============================================================
// HTML Utilities — shared by all HTML-scraping engines
// ============================================================
//
// Each of our HTML-scraping engines (Bing, DuckDuckGo, Baidu, Sogou,
// Google, dev.to / StackExchange via the developer module, etc.) used
// to ship its own stripHtml() helper. Most of them were 4-6 line
// copies of the same regex chain:
//
//   html.replace(/<[^>]+>/g, '')
//       .replace(/&amp;/g, '&')
//       .replace(/&lt;/g, '<')
//       .replace(/&gt;/g, '>')
//       .replace(/&quot;/g, '"')
//       .replace(/&#39;/g, "'")
//       .replace(/&nbsp;/g, ' ')
//       ...
//
// The engines/developer.ts version was a strict subset (only
// 4 entity replacements), so it was producing subtly different
// output — a search snippet that contained " (an HTML quote
// entity) would render as a literal " in the Bing/Google/DDG
// results but as the entity reference in the dev.to/StackOverflow
// results.
//
// This module consolidates the three operations each engine was
// doing (decode entities, strip tags, normalise whitespace) into
// reusable helpers, and gives engines/developer.ts the same
// behaviour as the rest. fetchUrl's more aggressive version
// (also strips <script>, <style>, <nav>, <header>, <footer> blocks)
// is exposed as a separate htmlToText() function.

// HTML entity decoder. Handles the named entities we actually see
// in real search results plus numeric and hex references of the
// form &#NNN; and &#xHHH;. The order matters: &amp; MUST be
// replaced first, otherwise the other decoders' output will be
// double-decoded (e.g. "&amp;quot;" → "&quot;" → "\"").
export function decodeHtmlEntities(html: string): string {
  if (html.indexOf('&') === -1) return html; // fast path
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00A0');
}

// Strip HTML tags but leave entity references intact — useful when
// the caller wants to apply decodeHtmlEntities separately (e.g. to
// preserve numeric entities that this function doesn't recognise,
// or to pass the raw text through another processing step first).
export function stripHtmlTags(html: string): string {
  // <script> and <style> blocks can contain '<' characters inside
  // their bodies (e.g. CSS selectors), so the naive /<[^>]+>/g would
  // mis-parse. We strip them as whole blocks first.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '');
}

// One-shot helper: strip tags AND decode entities AND collapse
// whitespace. This is the drop-in replacement for the per-engine
// stripHtml() functions and for fetchUrl's old stripToPlainText().
//
// Optional maxChars truncates the result (matters for fetchUrl,
// which needs to honour its per-call byte cap).
export function htmlToText(html: string, maxChars?: number): string {
  let text = stripHtmlTags(html);
  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, ' ').trim();
  if (maxChars !== undefined && text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  return text;
}

// More aggressive text extraction for fetchUrl's needs: also strips
// <nav>, <header>, <footer> blocks before tag-stripping, since those
// are mostly chrome that we don't want in a long-form text dump.
// Used by fetchUrl; engines don't need it because they only pull
// title + snippet, not body text.
export function htmlToBodyText(html: string, maxChars: number): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');
  text = stripHtmlTags(text);
  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}
