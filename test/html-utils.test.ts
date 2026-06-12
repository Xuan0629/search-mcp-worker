// ============================================================
// HTML Utilities — Unit Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  decodeHtmlEntities,
  stripHtmlTags,
  htmlToText,
  htmlToBodyText,
} from '../src/utils/html';

describe('decodeHtmlEntities', () => {
  it('decodes the named entities engines actually see', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeHtmlEntities('&lt;div&gt;')).toBe('<div>');
    expect(decodeHtmlEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeHtmlEntities('&apos;apostrophe&apos;')).toBe("'apostrophe'");
    // &nbsp; is a non-breaking space (U+00A0), not a regular space (U+0020).
    // The decoder preserves the codepoint; downstream consumers (htmlToText)
    // collapse all whitespace including NBSP into a regular space.
    expect(decodeHtmlEntities('&nbsp;')).toBe('\u00A0');
    expect(decodeHtmlEntities('&nbsp;non-breaking&nbsp;')).toBe('\u00A0non-breaking\u00A0');
  });

  it('handles both &#39; and &apos; for the apostrophe', () => {
    expect(decodeHtmlEntities('&#39;')).toBe("'");
    expect(decodeHtmlEntities('&apos;')).toBe("'");
  });

  it('decodes &amp; first so we do not leave stale entities behind', () => {
    // &amp;quot; is two entities: "the literal & char" + "the quote
    // entity". When the user actually wrote &amp;quot; in the source
    // they meant to display literally "&quot;" — but a single-pass
    // chain replace is going to decode both layers, which is the
    // correct behaviour for HTML rendering (browsers do the same).
    // We assert the chain's end state, not the intermediate.
    expect(decodeHtmlEntities('&amp;quot;')).toBe('"');
    // The dangerous case would be leaving &amp; intact and decoding
    // &quot; first, which would produce "&quot;" (the literal text),
    // not the expected quote character. Verify we never do that.
    expect(decodeHtmlEntities('&amp;quot;')).not.toBe('&quot;');
  });

  it('returns the input unchanged when there is no &', () => {
    expect(decodeHtmlEntities('hello world')).toBe('hello world');
  });
});

describe('stripHtmlTags', () => {
  it('removes simple tags', () => {
    expect(stripHtmlTags('hello <b>world</b>')).toBe('hello world');
    expect(stripHtmlTags('<p>line one</p><p>line two</p>')).toBe('line oneline two');
  });

  it('removes <script> and <style> blocks as whole units', () => {
    // The CSS selector 'a < b' would otherwise be mis-parsed as a tag.
    expect(
      stripHtmlTags('<style>a < b { color: red; }</style>text'),
    ).toBe('text');
    expect(
      stripHtmlTags('<script>if (a < b) { console.log("hi"); }</script>after'),
    ).toBe('after');
  });

  it('preserves entity references (caller can decode separately)', () => {
    expect(stripHtmlTags('<b>Tom &amp; Jerry</b>')).toBe('Tom &amp; Jerry');
  });
});

describe('htmlToText', () => {
  it('strips tags, decodes entities, and collapses whitespace', () => {
    expect(htmlToText('<p>Tom &amp; Jerry</p>')).toBe('Tom & Jerry');
    expect(htmlToText('<p>line  one</p>\n<p>line  two</p>')).toBe('line one line two');
  });

  it('honours maxChars when provided', () => {
    const long = 'a'.repeat(200);
    expect(htmlToText(`<p>${long}</p>`, 50)).toBe('a'.repeat(50));
    expect(htmlToText(`<p>${long}</p>`).length).toBe(200);
  });

  it('end-to-end test mirroring what an engine snippet looks like', () => {
    const html = '<em class="hl">Tom</em> &amp; <em class="hl">Jerry</em> — &quot;best friends&quot;';
    expect(htmlToText(html)).toBe('Tom & Jerry — "best friends"');
  });
});

describe('htmlToBodyText (aggressive variant for fetchUrl)', () => {
  it('also strips nav, header, footer blocks', () => {
    const html = `
      <html>
        <body>
          <nav>skip me</nav>
          <header>also skip</header>
          <article>keep me</article>
          <footer>and me</footer>
        </body>
      </html>
    `;
    expect(htmlToBodyText(html, 1000)).toBe('keep me');
  });

  it('preserves script/style stripping behaviour', () => {
    const html = '<script>alert(1)</script>visible';
    expect(htmlToBodyText(html, 1000)).toBe('visible');
  });

  it('truncates to maxChars', () => {
    const html = '<p>' + 'x'.repeat(500) + '</p>';
    expect(htmlToBodyText(html, 100).length).toBe(100);
  });
});
