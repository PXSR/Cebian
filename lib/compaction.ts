// 上下文压缩（compaction）领域模块：集中存放压缩消息类型、切点计算与摘要生成，
// 使压缩特性自包含。具体的「何时压缩 / 插入摘要 / 状态广播」编排在 agent-manager。

import type { Api, Model } from '@earendil-works/pi-ai';
import {
  type AgentMessage,
  type ThinkingLevel,
  estimateTokens,
  generateSummary,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-agent-core';

/**
 * 压缩摘要消息：当会话过长触发压缩时，被压缩的历史会被一段 LLM 生成的结构化
 * 摘要替代。这条消息直接作为一条普通成员存在于 `agent.state.messages` 数组里，
 * 跟随正常的持久化 / 广播 / UI 渲染管线，无需改动存储 schema。
 *
 * 关键不变式：摘要永远紧挨插在「保留区首条 user 消息」之前（切点对齐 user
 * turn-start），这样 `truncateForRetry` 无需特判即可正确工作。
 *
 * 字段形状对齐 pi harness 的 `CompactionSummaryMessage`：
 * - `summary`：LLM 生成的结构化摘要文本。
 * - `tokensBefore`：压缩前估算的上下文 token 数，仅用于 UI 显示「节省了多少」。
 * - `timestamp`：生成时间（ms）。
 */
export interface CompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

// 通过 pi-agent-core 官方提供的 declaration merging 扩展点，把 compactionSummary
// 注入 `AgentMessage` union，使其成为合法的 AgentMessage 成员（类型安全）。
declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    compactionSummary: CompactionSummaryMessage;
  }
}

/** 构造一条 compactionSummary 消息。 */
export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
): CompactionSummaryMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore,
    timestamp: Date.now(),
  };
}

/** 类型守卫：判断一条消息是否为 compactionSummary。 */
export function isCompactionSummary(
  msg: { role: string },
): msg is CompactionSummaryMessage {
  return msg.role === 'compactionSummary';
}

// ─── 切点计算（flat） ───

/**
 * 计算压缩切点：返回「保留区首条消息」的下标——它一定是一条 user 消息
 * （turn-start）。该下标之前的全部消息将被一段摘要替代。
 *
 * 为什么只在 user 消息处切：
 * - user 消息是一轮对话的起点；在此切点保证保留区从一条完整 user turn 开始，
 *   不会把 assistant 的 toolCall 与其 toolResult 拆散——孤立的 toolResult 正是
 *   issue #9 中 provider 返回 400 的根因。
 * - 同时天然规避 pi `findCutPoint` 的 split-turn 复杂度：保留区永远是若干完整轮次。
 *
 * 算法移植自 pi `findCutPoint` 的「从尾部累计 token」思路，扁平化（直接操作
 * `AgentMessage[]` 数组，而非 pi 的 SessionTreeEntry 树）且候选切点仅限 user 消息：
 * 1. 从最后一条消息往前累计估算 token，直到达到 keepRecentTokens，记边界 i。
 * 2. 取第一条下标 >= i 的 user 消息作切点（保留区 token 约等于预算，可能略少）。
 * 3. 若 i 之后已无 user 消息（末轮过长、无法在其内部安全切分），退取最后一条
 *    user 消息——宁可多保留，也不拆散一轮。
 *
 * @returns 保留区首条消息下标。若不存在 user 消息可切返回 -1；返回 <= 0 时
 *          调用方应视为「本轮不压缩」（其前没有可摘要的历史）。
 */
export function findCompactionCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number,
): number {
  // 候选切点：所有 user 消息下标。首条 user（通常下标 0）在此切等于不压缩，
  // 交由调用方按 cutIndex <= 0 判定 no-op，这里不特殊排除。
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i);
  }
  if (userIndices.length === 0) return -1;

  // 从尾部累计 token，确定「最近预算」的起始边界。总量不足预算时边界保持 0，
  // 最终退化为返回首条 user（no-op），这是安全的退化分支。
  let boundary = 0;
  let accumulated = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      boundary = i;
      break;
    }
  }

  // 取第一条 >= boundary 的 user 切点。
  for (const idx of userIndices) {
    if (idx >= boundary) return idx;
  }
  // boundary 之后无 user 消息：退取最后一条 user 切点（多保留，不拆轮次）。
  return userIndices[userIndices.length - 1];
}

// ─── 摘要生成（带重试） ───

/** {@link runCompaction} 的入参。 */
export interface RunCompactionParams {
  /** 待摘要的历史消息（切点之前的全部消息）。 */
  messagesToSummarize: AgentMessage[];
  model: Model<Api>;
  apiKey: string;
  /** 上一段压缩摘要，用于滚动更新（pi 内部走 UPDATE 提示词合并）。 */
  previousSummary?: string;
  /** 为摘要提示词与输出预留的 token；默认取 pi 的 DEFAULT_COMPACTION_SETTINGS。 */
  reserveTokens?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
}

/**
 * 生成一段压缩摘要：底层复用 pi 的 `generateSummary`（内部处理摘要提示词与
 * previousSummary 滚动合并），在其上叠加「失败重试一次」。
 *
 * 返回摘要文本；两次尝试都失败返回 null。调用方（agent-manager）据此走「不带
 * 摘要的 turn-start 截断」回退，并在后续轮次再次尝试压缩。
 *
 * 取消语义：每次尝试前检查 signal，已 abort 则直接返回 null 不再重试；若
 * generateSummary 返回 code='aborted' 的错误，同样视为取消而非失败。均遵守
 * pi-agent-core 的 cancellation 约定。
 */
export async function runCompaction(params: RunCompactionParams): Promise<string | null> {
  const {
    messagesToSummarize,
    model,
    apiKey,
    previousSummary,
    reserveTokens = DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    headers,
    signal,
    thinkingLevel,
  } = params;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) return null;
    const result = await generateSummary(
      messagesToSummarize,
      model,
      reserveTokens,
      apiKey,
      headers,
      signal,
      // customInstructions：Cebian 暂不暴露自定义摘要指令
      undefined,
      previousSummary,
      thinkingLevel,
    );
    if (result.ok) return result.value;
    // 取消不是失败：不记警告、不重试。
    if (result.error.code === 'aborted' || signal?.aborted) return null;
    console.warn(`[compaction] generateSummary failed (attempt ${attempt}/2):`, result.error);
  }
  return null;
}
