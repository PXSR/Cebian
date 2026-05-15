import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_SAVE_URL } from '@/lib/types';

/** RequestInit subset we accept from the agent. Only fields that make sense
 *  for a from-the-LLM call are exposed. Notably, `body` is restricted to
 *  string — LLMs don't have a way to construct ArrayBuffer / FormData, and
 *  serialising those through tool args would defeat the token-saving point
 *  of this tool. JSON bodies go through `JSON.stringify` in the agent. */
const FsSaveUrlInit = Type.Object({
  method: Type.Optional(Type.Union([
    Type.Literal('GET'), Type.Literal('POST'), Type.Literal('PUT'),
    Type.Literal('PATCH'), Type.Literal('DELETE'), Type.Literal('HEAD'),
  ], { description: 'HTTP method. Defaults to GET.' })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: 'HTTP request headers as a flat string-to-string object.',
  })),
  body: Type.Optional(Type.String({
    description: 'Request body. Only string bodies are supported — JSON-encode it yourself.',
  })),
  redirect: Type.Optional(Type.Union([
    Type.Literal('follow'), Type.Literal('error'), Type.Literal('manual'),
  ], { description: 'Redirect handling, mirrors fetch RequestInit.redirect. Defaults to "follow".' })),
  referrer: Type.Optional(Type.String({
    description:
      'Referrer URL for the request. Use "about:client" for the default ' +
      'or "no-referrer" to omit. Mirrors fetch RequestInit.referrer.',
  })),
  referrerPolicy: Type.Optional(Type.Union([
    Type.Literal(''), Type.Literal('no-referrer'), Type.Literal('no-referrer-when-downgrade'),
    Type.Literal('origin'), Type.Literal('origin-when-cross-origin'),
    Type.Literal('same-origin'), Type.Literal('strict-origin'),
    Type.Literal('strict-origin-when-cross-origin'), Type.Literal('unsafe-url'),
  ], { description: 'Referrer policy, mirrors fetch RequestInit.referrerPolicy.' })),
  credentials: Type.Optional(Type.Union([
    Type.Literal('omit'), Type.Literal('include'),
  ], { description: 'Cookie / auth credentials policy.' })),
  mode: Type.Optional(Type.Union([
    Type.Literal('cors'), Type.Literal('no-cors'),
  ], { description: 'Request mode, mirrors fetch RequestInit.mode.' })),
}, { description: 'Optional fetch init — subset of RequestInit.' });

/** Knobs that control how the response is saved into VFS. Kept under a
 *  separate `save` sub-object so the top-level signature stays focused on
 *  the fetch-equivalent shape. */
const FsSaveUrlSave = Type.Object({
  overwrite: Type.Optional(Type.Boolean({
    description: 'If false and `dest` already exists, the call fails. Defaults to true.',
  })),
  maxBytes: Type.Optional(Type.Number({
    description:
      'Abort and reject if the response body exceeds this many bytes. ' +
      'Defaults to 50 MB. Capped at a hard ceiling of 1 GB regardless of value.',
  })),
  sample: Type.Optional(Type.Boolean({
    description:
      'Include the first 1 KB of the saved content as `textSample` in the return ' +
      'value, but only for textual MIME types (text/*, application/json, etc.). ' +
      'Defaults to true. Binary MIME types never sample.',
  })),
}, { description: 'Optional save-behavior knobs.' });

const FsSaveUrlParameters = Type.Object({
  url: Type.String({
    description: 'The URL to fetch. Must be http(s).',
  }),
  dest: Type.String({
    description:
      'VFS path to save to. If `dest` ends with "/", the filename is derived from ' +
      'the response Content-Disposition header, the URL\'s last segment, or the ' +
      'MIME type (in that order). Otherwise `dest` is used verbatim as the file path.',
  }),
  init: Type.Optional(FsSaveUrlInit),
  save: Type.Optional(FsSaveUrlSave),
});

export const fsSaveUrlTool: AgentTool<typeof FsSaveUrlParameters> = {
  name: TOOL_FS_SAVE_URL,
  label: 'Save URL',
  description:
    'Fetch a URL and save the response body to a VFS file. ' +
    'Use this to put remote resources (images, videos, PDFs, JSON, etc.) into VFS without ' +
    'round-tripping bytes through the conversation — never base64-encode binary content ' +
    'and pass it to fs_create_file. Parameters mirror fetch(url, init).',
  parameters: FsSaveUrlParameters,

  async execute(_toolCallId, _params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    // Implemented incrementally — Task 2 fills in fetch + write, Task 3 adds
    // filename derivation, Task 4 adds size-cap + streaming abort, Task 5
    // adds textSample. Skeleton lives here so the tool is wired into the
    // session tool array (visible labels, callable surface) from day one.
    return {
      content: [{ type: 'text', text: 'Error: fs_save_url is not yet implemented' }],
      details: { status: 'error' },
    };
  },
};
