import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_EXECUTE_JS } from '@/lib/types';
import { executeViaDebugger } from '@/lib/tab-helpers';
import { vfs } from '@/lib/vfs';
import { invalidateSkillIndexIfNeeded } from './fs-helpers';

/** Sentinel value returned by the injected func when CSP blocks new Function(). */
const CSP_BLOCKED = '__cebian_csp_blocked__';

const ExecuteJsParameters = Type.Object({
  code: Type.String({
    description:
      'JavaScript code to execute in the target tab. ' +
      'The code is inserted as the body of `async () => { YOUR_CODE }` — use `return` directly to produce a result ' +
      '(e.g. `return document.title`). You can use `await` directly. ' +
      'NEVER wrap code in an IIFE like `(()=>{ return x })()` — the outer async function has no top-level `return`, so the result comes back as `(no return value)`. Use a bare top-level `return x` instead. ' +
      'The return value is JSON-serialized and returned to you in full — there is no hidden size limit, so do not pre-chunk results or probe for a maximum size. ' +
      'For results small enough to reason about inline, return them directly; for results large enough to bloat the conversation (full-page extracts, generated reports, structured data dumps), set `outputPath` to land them in VFS instead.',
  }),
  outputPath: Type.Optional(
    Type.String({
      description:
        'If set, the return value is written to this absolute VFS path (e.g. "/workspaces/abc/page.md") and only a short summary is returned to you. ' +
        'Use this whenever the natural result is large enough that returning it inline would bloat the conversation — the bytes go straight to disk and never enter your context. ' +
        'Strings are written verbatim; other values are written as pretty-printed JSON (2-space indent). ' +
        'Parent directories are created automatically. Existing files are overwritten. ' +
        'The script must `return` a non-empty value — returning null/undefined is an error.',
    }),
  ),
  frameId: Type.Optional(
    Type.Number({
      description:
        'Frame ID to execute in. Omit or 0 for the top frame. ' +
        'Use tab({ action: "list_frames" }) to discover frame IDs.',
    }),
  ),
  tabId: Type.Number({
    description:
      'Required. Tab ID to execute in. Read it from the `tabId:` line under `[Active Tab]` (or the windows list) in the context block. ' +
      'Never omit — the active tab may have changed since the last context snapshot.',
  }),
});

export const executeJsTool: AgentTool<typeof ExecuteJsParameters> = {
  name: TOOL_EXECUTE_JS,
  label: 'Execute JavaScript',
  description:
    'Execute JavaScript code in a browser tab and return the result. ' +
    'The code runs as an async function body — use `return` to produce a result (e.g. `return document.title`). ' +
    'Use for DOM operations, data extraction, page modifications, ' +
    'calling page APIs, or reading localStorage/sessionStorage. ' +
    'The code runs in the page context with full access to the DOM and page globals. ' +
    'The return value is JSON-serialized and returned in full — do not pre-chunk or probe for a size limit.',
  parameters: ExecuteJsParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = params.tabId;

    const target = params.frameId != null
      ? { tabId, frameIds: [params.frameId] }
      : { tabId };

    // Try executing via chrome.scripting.executeScript (MAIN world).
    // If the page has a strict CSP that blocks eval/new Function, the injected
    // func catches the error and returns a sentinel so we can fall back to CDP.
    const results = await chrome.scripting.executeScript({
      target,
      func: async (code: string, cspSentinel: string) => {
        try {
          return await new Function(`return (async () => { ${code} })()`)();
        } catch (e: any) {
          if (e.message && /unsafe-eval|Content Security Policy/i.test(e.message)) {
            return cspSentinel;
          }
          throw e;
        }
      },
      args: [params.code, CSP_BLOCKED],
      ...({ world: 'MAIN' } as any),
    });

    const result = results?.[0];

    // Two execution paths produce two different result shapes:
    //   - MAIN-world success: `result.result` is the raw return value (any
    //     JSON-serializable type, or `undefined` if the script didn't return).
    //   - CSP fallback: `executeViaDebugger` returns a string that is ALREADY
    //     display-formatted (the helper applies the same string-verbatim /
    //     JSON.stringify(_, null, 2) rules we use below). We don't have access
    //     to the original raw value through that path, so `outputPath` writes
    //     the helper's formatted text as-is.
    let rawValue: unknown;
    let cspFormatted: string | null = null;
    if (result?.result === CSP_BLOCKED) {
      cspFormatted = await executeViaDebugger(tabId, params.code);
    } else {
      rawValue = result?.result;
    }

    // ── outputPath branch ──
    // Bytes land directly in VFS; the agent only sees path + size + preview.
    if (params.outputPath) {
      let textToWrite: string;
      if (cspFormatted !== null) {
        // CSP fallback path. The helper may have returned a sentinel for
        // "no value" or an "Error: ..." string from CDP — surface both as
        // errors instead of writing them to disk.
        if (cspFormatted === '(no return value)') {
          return {
            content: [{ type: 'text', text: `Error: script returned no value — nothing to write to ${params.outputPath}. Use 'return <value>' in your script.` }],
            details: { status: 'error' },
          };
        }
        if (cspFormatted.startsWith('Error: ')) {
          return {
            content: [{ type: 'text', text: cspFormatted }],
            details: { status: 'error' },
          };
        }
        textToWrite = cspFormatted;
      } else {
        if (rawValue === undefined || rawValue === null) {
          return {
            content: [{ type: 'text', text: `Error: script returned ${rawValue === undefined ? 'undefined' : 'null'} — nothing to write to ${params.outputPath}. Use 'return <value>' in your script.` }],
            details: { status: 'error' },
          };
        }
        try {
          textToWrite = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue, null, 2);
        } catch {
          return {
            content: [{ type: 'text', text: `Error: result could not be serialized to text (got ${typeof rawValue}).` }],
            details: { status: 'error' },
          };
        }
      }

      try {
        await vfs.writeFile(params.outputPath, textToWrite, 'utf8');
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error writing ${params.outputPath}: ${(err as Error).message}` }],
          details: { status: 'error' },
        };
      }
      invalidateSkillIndexIfNeeded(params.outputPath);

      const byteLen = new TextEncoder().encode(textToWrite).length;
      const preview = textToWrite.length > 1024
        ? textToWrite.slice(0, 1024) + '\n…(preview truncated; full content is on disk)'
        : textToWrite;
      return {
        content: [{ type: 'text', text: `Wrote ${params.outputPath} (${byteLen} bytes)\nPreview:\n---\n${preview}\n---` }],
        details: { status: 'done' },
      };
    }

    // ── Inline-return branch (unchanged behavior) ──
    let text: string;
    if (cspFormatted !== null) {
      text = cspFormatted;
    } else {
      try {
        text = rawValue === undefined ? '(no return value)' : JSON.stringify(rawValue, null, 2);
      } catch {
        text = `(result could not be serialized — got ${typeof rawValue})`;
      }
    }

    return {
      content: [{ type: 'text', text }],
      details: { status: 'done' },
    };
  },
};
