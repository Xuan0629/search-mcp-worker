// ============================================================
// makeToolError — Unit Tests
// ============================================================
//
// makeToolError is the protocol-level error wrapper for tool calls.
// It must:
//   1. Set isError: true so MCP clients can distinguish tool errors
//      from normal results programmatically (per the MCP spec).
//   2. Prefix the text with "Error: " for human readability, so the
//      same convention used by JSON-RPC and LSP is preserved.
//   3. Carry the original error message verbatim in the text body
//      so the caller can read it without parsing.

import { describe, it, expect } from 'vitest';
import { makeToolError } from '../src/mcp/protocol';

describe('makeToolError', () => {
  it('sets isError: true on the result', () => {
    const r = makeToolError('something went wrong');
    expect(r.isError).toBe(true);
  });

  it('prefixes the text body with "Error: "', () => {
    const r = makeToolError('HTTP 404: NOT FOUND');
    expect(r.content[0].text).toBe('Error: HTTP 404: NOT FOUND');
  });

  it('preserves the original error message verbatim', () => {
    const r = makeToolError('engine \'bocha\' is disabled (see DISABLED_ENGINES in index.ts)');
    expect(r.content[0].text).toContain('engine \'bocha\' is disabled');
  });

  it('returns exactly one content entry (text type)', () => {
    const r = makeToolError('oops');
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
  });

  it('does not include a structuredContent (errors are not structured data)', () => {
    const r = makeToolError('oops');
    expect(r.structuredContent).toBeUndefined();
  });
});
