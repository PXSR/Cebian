// Background Agent Manager — singleton that manages Agent instances.
// Each session gets its own Agent + SessionToolContext (per-session isolation).

import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { getModels, type KnownProvider } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { scanSkillIndex, buildSkillsBlock } from '@/lib/ai-config/scanner';
import { sessionStore } from './session-store';
import { gatherPageContext } from '@/lib/page-context';
import { buildTextPrefix, extractImages, type Attachment } from '@/lib/attachments';
import { createSessionTools, buildSessionToolArray } from '@/lib/tools';
import type { SessionToolContext } from '@/lib/tools/session-context';
import type { ServerMessage } from '@/lib/protocol';
import type { SessionRecord } from '@/lib/db';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  activeModel as activeModelStorage,
  thinkingLevel as thinkingLevelStorage,
  userInstructions as userInstructionsStorage,
  maxRounds as maxRoundsStorage,
} from '@/lib/storage';
import { getMCPManager } from '@/lib/mcp/manager';
import { getCopilotBaseUrl } from '@/lib/oauth';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { t } from '@/lib/i18n';
import { acquireKeepAlive, releaseKeepAlive } from './sw-keepalive';

// ─── Structured user message builder ───

async function buildStructuredMessage(text: string, attachments: Attachment[]): Promise<string> {
  const parts: string[] = [];

  // ① Session-dynamic config: inject skill index
  const skillMetas = await scanSkillIndex();
  const skillsBlock = buildSkillsBlock(skillMetas);
  parts.push(`<agent-config>\n${skillsBlock}\n</agent-config>`);

  // ② Tool/behavior reminders (placeholder)
  parts.push('<reminder-instructions>\n</reminder-instructions>');

  // ③ Attachments (elements + files; images go via multimodal content blocks)
  const attachmentBlock = buildTextPrefix(attachments);
  if (attachmentBlock) parts.push(attachmentBlock);

  // ④ Context: date + page state
  const ctxLines: string[] = [];
  ctxLines.push(`The current date is ${new Date().toLocaleDateString('en-CA')}.`);
  const pageCtx = await gatherPageContext();
  if (pageCtx) {
    ctxLines.push('');
    ctxLines.push(pageCtx);
  }
  parts.push(`<context>\n${ctxLines.join('\n')}\n</context>`);

  // ⑤ User request (always last)
  // TODO: user text is NOT sanitized — users are trusted; stripping structural tags would alter their intent.
  parts.push(`<user-request>\n${text.trim()}\n</user-request>`);

  return parts.join('\n\n');
}

// ─── Types ───

interface ManagedSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  isRunning: boolean;
  modelKey: string;
  /** Unified interactive tool bridge manager for this session. */
  toolCtx: SessionToolContext;
  unsubscribeAgent: () => void;
  unsubscribeToolCtx: () => void;
}

type BroadcastFn = (sessionId: string, msg: ServerMessage) => void;

// ─── Agent Manager ───

class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  /** Guards against concurrent getOrCreateAgent calls for the same session. */
  private creating = new Map<string, Promise<ManagedSession>>();
  /** Per-session synchronous mutex for retry(). Prevents two retry() calls
   *  (or a retry racing against itself across a network round-trip) from
   *  both passing the `isRunning` check and spawning orphan agents. The
   *  flag is set BEFORE the first await so the second caller hits it
   *  synchronously before any context switch. */
  private retrying = new Set<string>();
  private broadcast: BroadcastFn = () => {};
  /** True iff we're currently holding a SW keep-alive token. Tracked so
   *  acquire/release stay balanced even across error paths. */
  private keepAliveHeld = false;
  /** Subscription to MCPManager change notifications; pushes refreshed tools into every live session. */
  private mcpUnsubscribe?: () => void;

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
    // Subscribe to MCPManager so we react AFTER its internal entries map is
    // reconciled — avoids racing two independent storage watchers.
    if (!this.mcpUnsubscribe) {
      this.mcpUnsubscribe = getMCPManager().subscribe(() => {
        void this.refreshAllSessionTools();
      });
    }
  }

  /**
   * Rebuild every live session's tool array from current MCP config.
   * Called when the user adds, removes, enables, disables, or edits an MCP
   * server. The agent's `state.tools` setter accepts a fresh array, so a
   * mid-run update is safe — the next assistant turn picks up the new tools.
   *
   * Sessions refresh in parallel; manager-level dedup prevents fan-out reconnects.
   */
  private async refreshAllSessionTools(): Promise<void> {
    if (this.sessions.size === 0) return;
    await Promise.allSettled(
      Array.from(this.sessions.values()).map(async (managed) => {
        try {
          const tools = await buildSessionToolArray(managed.toolCtx);
          managed.agent.state.tools = tools;
        } catch (err) {
          console.warn(`[mcp] failed to refresh tools for session ${managed.sessionId}:`, err);
        }
      }),
    );
  }

  /**
   * Acquire / release a SW keep-alive token based on whether any session is running.
   * Uses the shared ref-counted helper in `sw-keepalive.ts` so multiple subsystems
   * (agent runs, active recordings, ...) coexist without stomping each other.
   */
  private updateKeepAlive(): void {
    const hasRunning = [...this.sessions.values()].some(s => s.isRunning);
    if (hasRunning && !this.keepAliveHeld) {
      this.keepAliveHeld = true;
      acquireKeepAlive();
    } else if (!hasRunning && this.keepAliveHeld) {
      this.keepAliveHeld = false;
      releaseKeepAlive();
    }
  }

  private async resolveModelObj(): Promise<{ model: Model<Api>; provider: string; modelId: string } | null> {
    const [modelCfg, creds, customProvs] = await Promise.all([
      activeModelStorage.getValue(),
      providerCredentials.getValue(),
      customProvidersStorage.getValue(),
    ]);
    if (!modelCfg) return null;

    const allCustom = mergeCustomProviders(PRESET_PROVIDERS, customProvs ?? []);
    let model: Model<Api> | undefined;

    if (isCustomProvider(modelCfg.provider)) {
      model = findCustomModel(allCustom, modelCfg.provider, modelCfg.modelId) ?? undefined;
    } else {
      try {
        const models = getModels(modelCfg.provider as KnownProvider) as Model<Api>[];
        model = models.find(m => m.id === modelCfg.modelId);
      } catch {
        return null;
      }
    }
    if (!model) return null;

    if (modelCfg.provider === 'github-copilot') {
      const cred = creds[modelCfg.provider];
      if (cred?.authType === 'oauth') {
        model = { ...model, baseUrl: getCopilotBaseUrl(cred) };
      }
    }

    return { model, provider: modelCfg.provider, modelId: modelCfg.modelId };
  }

  /** Get or create a managed agent for a session */
  private async getOrCreateAgent(sessionId: string, existingMessages?: AgentMessage[]): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existingMessages) return existing;

    // Guard against concurrent creation
    const pending = this.creating.get(sessionId);
    if (pending && !existingMessages) return pending;

    const promise = this.createAgent(sessionId, existingMessages);
    this.creating.set(sessionId, promise);
    try {
      const managed = await promise;
      return managed;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  /** Internal: actually create the agent (called only once per session). */
  private async createAgent(sessionId: string, existingMessages?: AgentMessage[]): Promise<ManagedSession> {

    const resolved = await this.resolveModelObj();
    if (!resolved) throw new Error('No model selected or model not found');

    const [thinkingLvl, instructions, rounds] = await Promise.all([
      thinkingLevelStorage.getValue(),
      userInstructionsStorage.getValue(),
      maxRoundsStorage.getValue(),
    ]);

    // Use provided messages, or load from DB, or start empty
    let messages: AgentMessage[] = existingMessages ?? [];
    let sessionCreated = false;
    if (!existingMessages) {
      const existingSession = await sessionStore.load(sessionId);
      messages = existingSession?.messages ?? [];
      sessionCreated = !!existingSession;
    }

    // Create per-session tools with isolated bridges
    const { tools: sessionTools, ctx: toolCtx } = await createSessionTools();

    const agent = createCebianAgent({
      model: resolved.model,
      sessionId,
      userInstructions: instructions || '',
      thinkingLevel: (thinkingLvl || 'medium') as any,
      maxRounds: rounds || 200,
      messages,
      tools: sessionTools,
    });

    const managed: ManagedSession = {
      agent,
      sessionId,
      sessionCreated,
      isRunning: false,
      modelKey: `${resolved.provider}/${resolved.modelId}`,
      toolCtx,
      unsubscribeAgent: () => {},
      unsubscribeToolCtx: () => {},
    };

    // Subscribe to agent events
    managed.unsubscribeAgent = agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(managed, event);
    });

    // Subscribe to all interactive tool state changes for this session
    managed.unsubscribeToolCtx = toolCtx.subscribe((toolName, pending) => {
      if (pending) {
        this.broadcast(sessionId, {
          type: 'tool_pending',
          sessionId,
          toolName,
          toolCallId: pending.toolCallId,
          args: pending.request,
        });
      } else {
        this.broadcast(sessionId, {
          type: 'tool_resolved',
          sessionId,
          toolName,
        });
      }
    });

    this.sessions.set(sessionId, managed);
    return managed;
  }

  private async handleAgentEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    const { sessionId, agent } = managed;

    switch (event.type) {
      case 'agent_start':
        managed.isRunning = true;
        this.broadcast(sessionId, { type: 'agent_start', sessionId });
        this.updateKeepAlive();
        break;

      case 'message_update':
        if ('role' in event.message && event.message.role === 'assistant') {
          this.broadcast(sessionId, {
            type: 'message_update',
            sessionId,
            message: event.message,
          });
        }
        break;

      case 'message_end': {
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'message_end', sessionId, messages });
        if (managed.sessionCreated) {
          sessionStore.scheduleWrite(sessionId, messages);
        }
        break;
      }

      case 'agent_end': {
        managed.isRunning = false;
        this.updateKeepAlive();
        // Cancel any pending interactive tools on this session
        managed.toolCtx.cancelAll();
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'agent_end', sessionId, messages });
        await sessionStore.flush(sessionId);
        break;
      }
    }
  }

  /** Send a prompt to the agent for a session */
  async prompt(sessionId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    // Persist + broadcast 'session_created' for brand-new sessions BEFORE any
    // agent setup work (model resolve, tool factory, MCP, createAgent — easily
    // several hundred ms). Without this the UI stays on /chat/new with an empty
    // title and a no-op "new chat" button until the first agent_start arrives.
    //
    // Detection: not in the live sessions map AND no DB record. The DB record
    // we write here is what getOrCreateAgent's sessionStore.load() will find,
    // so `managed.sessionCreated` is set to true by createAgent() naturally,
    // and we don't need a second persist-and-broadcast inside this method.
    if (!this.sessions.has(sessionId)) {
      const existing = await sessionStore.load(sessionId);
      if (!existing) {
        const [modelCfg, instructions, thinkingLvl] = await Promise.all([
          activeModelStorage.getValue(),
          userInstructionsStorage.getValue(),
          thinkingLevelStorage.getValue(),
        ]);
        // Mirror the old behavior: refuse to create a session row when no
        // model is selected. Otherwise the subsequent getOrCreateAgent() throws
        // and we'd leave an orphan empty-model row in Dexie + history.
        if (!modelCfg) {
          throw new Error('No model selected or model not found');
        }
        const trimmed = text.trim();
        const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
        const session: SessionRecord = {
          id: sessionId,
          title: title || t('common.newChat'),
          model: modelCfg.modelId,
          provider: modelCfg.provider,
          userInstructions: instructions || '',
          thinkingLevel: thinkingLvl || 'medium',
          messageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        };
        try {
          await sessionStore.create(session);
          this.broadcast(sessionId, {
            type: 'session_created',
            sessionId,
            title: session.title,
          });
        } catch (err: any) {
          // Race: another concurrent prompt() for the same brand-new id won
          // the create. Re-throw anything that isn't a duplicate-key violation;
          // the winning call has already broadcast 'session_created'.
          if (err?.name !== 'ConstraintError') throw err;
        }
      }
    }

    let managed = await this.getOrCreateAgent(sessionId);

    // Check if the model has changed since the agent was created
    const currentModel = await activeModelStorage.getValue();
    if (currentModel) {
      const currentKey = `${currentModel.provider}/${currentModel.modelId}`;
      if (currentKey !== managed.modelKey) {
        // Model changed — recreate with new model, preserving in-memory messages
        const currentMessages = [...managed.agent.state.messages];
        const wasCreated = managed.sessionCreated;
        managed.unsubscribeAgent();
        managed.unsubscribeToolCtx();
        managed.toolCtx.dispose();
        this.sessions.delete(sessionId);
        this.updateKeepAlive();
        managed = await this.getOrCreateAgent(sessionId, currentMessages);
        managed.sessionCreated = wasCreated;
      }
    }

    const enriched = await buildStructuredMessage(text, attachments);

    const images = extractImages(attachments);

    // If any interactive tool is pending, steer the agent instead of prompting
    if (managed.toolCtx.hasPending()) {
      const content: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) content.push(...images);
      const userMessage: AgentMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      } as AgentMessage;
      // Enqueue BEFORE cancelling so getSteeringMessages() sees it when the loop drains.
      managed.agent.steer(userMessage);
      managed.toolCtx.cancelAll();
    } else {
      await managed.agent.prompt(enriched, images.length > 0 ? images : undefined);
    }
  }

  /**
   * Re-run the last user turn for a session.
   *
   * Drops trailing assistant / toolResult messages after the most recent
   * user message and resumes the agent loop from there. Used by the chat
   * UI's "Retry" button — covers both genuine failures (`stopReason: 'error'`)
   * and successful turns the user is unhappy with.
   *
   * No-op if no user message exists in the transcript, or if the agent is
   * currently running for this session (the UI guards against this, but a
   * stale port message could still race in).
   */
  async retry(sessionId: string): Promise<void> {
    // Synchronous mutex BEFORE any await. Without this, two retry() calls
    // landing in the same tick (double-click, multi-window race, stale port
    // message, etc.) can both pass the `isRunning` check below — the first
    // call hasn't yet had a chance to fire `agent_start` — dispose each
    // other's agents, and leave one streaming into the void.
    //
    // Concurrent retry is a benign duplicate of an already-in-flight intent,
    // not a user error: the retry IS in fact happening, just via the first
    // caller. We silently no-op so the duplicate window doesn't see a
    // misleading "Retry already in progress" toast. The duplicate caller's
    // subscribed port will converge to the right state via the in-flight
    // retry's `session_state` / `agent_start` broadcasts.
    if (this.retrying.has(sessionId)) {
      console.debug('[agent-manager] retry: concurrent call ignored', sessionId);
      return;
    }
    this.retrying.add(sessionId);
    try {
      // Cold-load from DB if needed. This mirrors `prompt()` for sessions
      // the user is viewing after a SW restart.
      let managed = await this.getOrCreateAgent(sessionId);

      // Same reasoning as the mutex: by the time we get here, another caller
      // may already have kicked off a retry that's now running. Silent no-op
      // — the in-flight run's broadcasts will reconcile every window's view.
      if (managed.isRunning) {
        console.debug('[agent-manager] retry: agent already running, ignored', sessionId);
        return;
      }

      const messages = [...managed.agent.state.messages];

      // Find the most recent user-role message. Steered user messages count
      // too — semantically they ARE the latest user input.
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) {
        // This SHOULD be unreachable: the UI only shows retry on the latest
        // assistant turn, which by definition has a preceding user message.
        // Throwing here surfaces the bug instead of silently no-oping.
        throw new Error('No user message found to retry');
      }

      // Truncate to the last user message inclusive — drops the failed/
      // unwanted assistant turn AND any orphan toolResult / toolUse blocks
      // that came after it (mid-tool-round failures, etc.).
      const truncated = messages.slice(0, lastUserIdx + 1);

      // Persist the truncation BEFORE dispose/recreate so a SW restart in
      // the recreate window doesn't resurrect the failed message from disk.
      // `flush` collapses the throttler's pending timer and writes
      // immediately; this also closes the subscribe-during-recreate race
      // (a subscriber that lands between sessions.delete and the new
      // managed install reads truncated state from DB, not stale state).
      if (managed.sessionCreated) {
        sessionStore.scheduleWrite(sessionId, truncated);
        await sessionStore.flush(sessionId);
      }

      // Defensive: cancel any pending interactive tool. The UI hides the retry
      // button while a tool is pending, but a stale message could still arrive.
      managed.toolCtx.cancelAll();

      // Recreate the agent with the truncated transcript. pi-agent-core's
      // `state.messages` isn't safely mutable from outside, so we dispose
      // and rebuild — same pattern as the model-change branch in `prompt()`.
      // The recreation also picks up the CURRENT active model, which is the
      // desired behavior: if the user switched models after a failure (e.g.
      // because the previous model id wasn't supported), retry uses the new
      // one.
      const wasCreated = managed.sessionCreated;
      managed.unsubscribeAgent();
      managed.unsubscribeToolCtx();
      managed.toolCtx.dispose();
      this.sessions.delete(sessionId);
      this.updateKeepAlive();
      managed = await this.getOrCreateAgent(sessionId, truncated);
      managed.sessionCreated = wasCreated;

      // Broadcast the truncated state so subscribed sidepanels drop the
      // failed assistant bubble immediately. Without this the stale bubble
      // would linger until the new turn streams its first chunk — and even
      // then the client's `message_update` handler would push the new
      // assistant alongside the old one rather than replacing it.
      //
      // `isRunning: true` is the truthful value here: `continue()` is
      // invoked on the very next line and fires `agent_start` on entry,
      // so the agent IS effectively running. Broadcasting `false` would
      // cause a visible T(broadcast) → T(agent_start) flicker on every
      // subscribed window — briefly re-enabling the composer and breaking
      // the optimistic-running guarantee the hook sets up on click.
      this.broadcast(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
      });

      // `continue()` resumes the agent loop against the current transcript.
      // Since the last message is a user message after our truncation, it
      // re-prompts the LLM without appending a duplicate user message.
      await managed.agent.continue();
    } finally {
      // Release the mutex even on throw. By this point either `continue()`
      // has emitted `agent_start` (so `managed.isRunning === true` blocks
      // subsequent retries naturally) or we threw before getting that far
      // and the next retry attempt is allowed to proceed.
      this.retrying.delete(sessionId);
    }
  }

  /**
   * Cancel the active agent for a session.
   *
   * Flushes the throttled session writer BEFORE removing the agent from the
   * map so any concurrent `subscribe` / `prompt` for the same id either
   * reuses the still-live in-memory state or reads a fully-persisted DB
   * row — never an interleaved half-flushed snapshot.
   */
  async cancel(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    managed.agent.abort();
    managed.unsubscribeAgent();
    managed.toolCtx.dispose();
    // Persist whatever the assistant produced before the abort. The agent's
    // `agent_end` event is what normally schedules the final write, but
    // `abort()` may skip it; flushing here covers both paths idempotently.
    try {
      await sessionStore.flush(sessionId);
    } catch (err) {
      console.warn(`[agent-manager] flush on cancel failed for ${sessionId}:`, err);
    }
    this.sessions.delete(sessionId);
    this.updateKeepAlive();
    // Ensure client knows the agent stopped (abort may not fire agent_end)
    this.broadcast(sessionId, {
      type: 'agent_end',
      sessionId,
      messages: [...managed.agent.state.messages],
    });
  }

  /** Resolve an interactive tool's pending request */
  resolveTool(sessionId: string, toolName: string, response: any): void {
    const managed = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    managed?.toolCtx.resolve(toolName, response);
  }

  /** Cancel a specific interactive tool */
  cancelTool(sessionId: string, toolName: string): void {
    const managed = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    managed?.toolCtx.cancel(toolName);
  }

  /** Get current state for a session (for reconnecting clients) */
  getSessionState(sessionId: string): { messages: AgentMessage[]; isRunning: boolean } | null {
    const managed = this.sessions.get(sessionId);
    if (!managed) return null;
    return {
      messages: [...managed.agent.state.messages],
      isRunning: managed.isRunning,
    };
  }

  /** Destroy a managed session entirely */
  destroySession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.unsubscribeAgent();
      managed.toolCtx.dispose();
      managed.agent.abort();
      this.sessions.delete(sessionId);
      this.updateKeepAlive();
    }
  }
}

export const agentManager = new AgentManager();
