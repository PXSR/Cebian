import { useState, useEffect, type KeyboardEvent } from 'react';
import { CircleHelp, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { AskUserRequest, AskUserAnswer, AskUserResponse } from '@/lib/tools/ask-user';

/* ─── Ask User Block (interactive tool UI) ─── */
// 批量多问题翻页表单。三态：
// - interactive（isPending 且有 onSubmit）：可填写、左右翻页，仅末页出现「提交」。
// - answered（!isPending 且有 answers）：置灰只读，展示每题所选 / 自由文本 / 已跳过。
// - cancelled / expired（!isPending 且无 answers）：置灰只读，可浏览但无答案。
// 防御性：流式半包 / 字段缺失时过滤掉非法问题；无可用问题则返回 null 而非黑屏。
type AskUserQuestion = AskUserRequest['questions'][number];

// details.answers 可能来自旧持久化 / 畸形数据，渲染前强制归一到合法形状；
// 非法项视为缺失（返回 undefined），避免 ans.selected.includes 报错或非法 React 子节点。
function coerceAnswer(raw: unknown): AskUserAnswer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { selected?: unknown; free_text?: unknown; skipped?: unknown };
  return {
    selected: Array.isArray(r.selected) ? r.selected.filter((s): s is string => typeof s === 'string') : [],
    free_text: typeof r.free_text === 'string' ? r.free_text : '',
    skipped: r.skipped === true,
  };
}

// 某题的默认选中项：推荐项即默认选中（单选取第一个推荐，多选取全部推荐）。
// 「推荐」不再单独显示文案，而是直接体现为默认选中状态。
function recommendedDefaults(q: AskUserQuestion): string[] {
  const opts = Array.isArray(q.options) ? q.options : [];
  const recs = opts
    .filter(
      (o) =>
        !!o &&
        typeof o === 'object' &&
        typeof (o as { label?: unknown }).label === 'string' &&
        (o as { recommended?: unknown }).recommended === true,
    )
    .map((o) => (o as { label: string }).label);
  return q.multiple === true ? recs : recs.slice(0, 1);
}

// 表单选项按钮：选中态用 check 图标 + 主色描边/浅底，比权限卡的实心高亮更轻，
// 多选多个同时选中时也不会一片刺眼的实色。
function FormOptionButton({
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={description}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 h-7 text-xs transition-colors',
        selected
          ? 'border-primary bg-primary/10 text-primary font-medium'
          : 'border-border bg-background text-foreground',
        disabled ? 'cursor-default' : 'hover:bg-muted cursor-pointer',
      )}
    >
      {selected && <Check className="size-3 shrink-0" />}
      {label}
    </button>
  );
}

export function AskUserBlock({
  questions,
  answers,
  isPending,
  onSubmit,
}: {
  questions?: AskUserQuestion[];
  answers?: Record<string, AskUserAnswer>;
  isPending?: boolean;
  onSubmit?: (response: AskUserResponse) => void;
}) {
  const interactive = !!onSubmit && !!isPending;

  // 防御性过滤：只保留形状合法的问题（id / question 为非空字符串）。
  const safeQuestions = Array.isArray(questions)
    ? questions.filter(
        (q): q is AskUserQuestion =>
          !!q && typeof q === 'object' && typeof q.id === 'string' && !!q.id && typeof q.question === 'string',
      )
    : [];

  const [page, setPage] = useState(0);
  // 草稿：每题 id → { selected, free_text }。提交时据此推导 skipped。
  const [draft, setDraft] = useState<Record<string, { selected: string[]; free_text: string }>>({});

  // 流式期间 questions 数量可能伸缩；长度变化时把 page 钳在合法区间，避免遗留越界的 page 状态。
  useEffect(() => {
    if (safeQuestions.length > 0) {
      setPage((p) => Math.min(p, safeQuestions.length - 1));
    }
  }, [safeQuestions.length]);

  if (safeQuestions.length === 0) return null;

  const clampedPage = Math.min(page, safeQuestions.length - 1);
  const q = safeQuestions[clampedPage];
  const isLast = clampedPage >= safeQuestions.length - 1;
  const cur = draft[q.id] ?? { selected: recommendedDefaults(q), free_text: '' };
  const ans = coerceAnswer(answers?.[q.id]);

  // 防御性归一：严格布尔判断 multiple / allow_free_text，避免流式半包里 'false' 字符串被当真。
  const multiple = q.multiple === true;
  const allowFreeText = typeof q.allow_free_text === 'boolean' ? q.allow_free_text : true;
  const safeOptions = Array.isArray(q.options)
    ? q.options
        .filter((o) => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string')
        .map((o) => ({
          label: o.label,
          description: typeof o.description === 'string' ? o.description : undefined,
          recommended: o.recommended === true,
        }))
    : [];

  const toggleOption = (label: string) => {
    setDraft((prev) => {
      const d = prev[q.id] ?? { selected: recommendedDefaults(q), free_text: '' };
      let selected: string[];
      if (multiple) {
        selected = d.selected.includes(label) ? d.selected.filter((l) => l !== label) : [...d.selected, label];
      } else {
        selected = d.selected.includes(label) ? [] : [label];
      }
      return { ...prev, [q.id]: { ...d, selected } };
    });
  };

  const setFreeText = (val: string) => {
    setDraft((prev) => {
      const d = prev[q.id] ?? { selected: recommendedDefaults(q), free_text: '' };
      return { ...prev, [q.id]: { ...d, free_text: val } };
    });
  };

  const submit = () => {
    const result: Record<string, AskUserAnswer> = {};
    for (const sq of safeQuestions) {
      const d = draft[sq.id] ?? { selected: recommendedDefaults(sq), free_text: '' };
      const free_text = d.free_text.trim();
      result[sq.id] = {
        selected: d.selected,
        free_text,
        skipped: d.selected.length === 0 && free_text === '',
      };
    }
    onSubmit?.({ answers: result });
  };

  // 「下一题」未作答即在提交时算 skipped；这里只前进，不强制作答。
  const goNext = () => (isLast ? submit() : setPage(clampedPage + 1));
  const goPrev = () => setPage(Math.max(0, clampedPage - 1));

  // Enter（非 Shift）= 前进 / 末页提交；Shift+Enter = 换行。
  // isComposing 期间（中/日/韩输入法组词）的 Enter 是“确认候选词”，不能误触发前进/提交。
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      goNext();
    }
  };

  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${interactive ? '' : 'opacity-60'}`}>
      {/* Question header + progress */}
      <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem] mb-1">
        <CircleHelp className="size-4.5 shrink-0 mt-0.5" />
        <span className="whitespace-pre-wrap flex-1">{q.question}</span>
        {safeQuestions.length > 1 && (
          <span className="shrink-0 text-[0.7rem] font-normal text-muted-foreground tabular-nums mt-0.5">
            {clampedPage + 1} / {safeQuestions.length}
          </span>
        )}
      </div>

      {/* Optional supporting message */}
      {typeof q.message === 'string' && q.message && (
        <div className="text-xs text-muted-foreground whitespace-pre-wrap mb-1 ml-6.5">{q.message}</div>
      )}

      {/* Multi-select hint */}
      {multiple && safeOptions.length > 0 && (
        <div className="text-[0.7rem] text-muted-foreground/80 ml-6.5 mb-1">{t('chat.askUser.multiHint')}</div>
      )}

      {/* Options */}
      {safeOptions.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2 ml-6.5">
          {safeOptions.map((opt, i) => {
            const selected = interactive ? cur.selected.includes(opt.label) : !!ans?.selected.includes(opt.label);
            return (
              <FormOptionButton
                key={`${i}-${opt.label}`}
                label={opt.label}
                description={opt.description}
                selected={selected}
                disabled={!interactive}
                onClick={interactive ? () => toggleOption(opt.label) : undefined}
              />
            );
          })}
        </div>
      )}

      {/* Free-text field */}
      {allowFreeText && (
        <div className="mt-2 ml-6.5">
          {interactive ? (
            <Textarea
              rows={1}
              value={cur.free_text}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('chat.askUser.placeholder')}
              // field-sizing-content（基类自带）随内容自动增高；max-h 以行（lh）为上限，
              // 未超 6 行不出滚动条，超过才滚动。改行数只需改 6 这个数字。
              className="min-h-0 max-h-[6lh] resize-none bg-background text-xs md:text-xs leading-relaxed px-2.5 py-1.5"
            />
          ) : (
            ans?.free_text && (
              <div className="text-xs leading-relaxed whitespace-pre-wrap bg-background/60 border border-border rounded-md px-2.5 py-1.5">
                {ans.free_text}
              </div>
            )
          )}
        </div>
      )}

      {/* Answered: skipped marker */}
      {!interactive && ans?.skipped && (
        <div className="text-xs text-muted-foreground/80 italic mt-2 ml-6.5">{t('chat.askUser.skipped')}</div>
      )}

      {/* Navigation row */}
      <div className="flex items-center justify-between gap-2 mt-3 ml-6.5">
        <Button
          variant="outline"
          size="sm"
          className="text-xs h-7"
          disabled={clampedPage === 0}
          onClick={goPrev}
        >
          <ChevronLeft className="size-3.5" />
          {t('chat.askUser.previous')}
        </Button>

        {interactive && isLast ? (
          <Button variant="default" size="sm" className="text-xs h-7" onClick={goNext}>
            {t('chat.askUser.submit')}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7"
            disabled={!interactive && isLast}
            onClick={goNext}
          >
            {t('chat.askUser.next')}
            <ChevronRight className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
