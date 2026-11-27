import * as z from 'zod/mini';

export const ANSWER_VISUAL_LANGUAGE = 'eterx-visual';
export const ANSWER_DETAILS_MARKER = '[!DETAILS]';
export const ANSWER_VISUAL_LIMITS = { metrics: 6, bar: 16, line: 64, timeline: 16 } as const;

const text = (max: number) => z.string().check(z.trim(), z.minLength(1), z.maxLength(max));
const title = text(120);
const itemLabel = { label: title, detail: z.optional(text(240)) };
const caption = z.optional(text(360));
const unit = z.optional(text(72));
const display = z.optional(text(80));
const numericItem = { ...itemLabel, display };

const metrics = z.object({
  type: z.literal('metrics'), title, caption,
  items: z.array(z.object({ ...itemLabel, value: z.union([text(80), z.number()]) }))
    .check(z.minLength(1), z.maxLength(ANSWER_VISUAL_LIMITS.metrics)),
});

const bar = z.object({
  type: z.literal('bar'), title, caption, unit,
  items: z.array(z.object({ ...numericItem, value: z.number() }))
    .check(z.minLength(1), z.maxLength(ANSWER_VISUAL_LIMITS.bar)),
});

const line = z.object({
  type: z.literal('line'), title, caption, unit,
  items: z.array(z.object({ ...numericItem, value: z.nullable(z.number()) }))
    .check(z.minLength(2), z.maxLength(ANSWER_VISUAL_LIMITS.line),
      z.refine(items => items.filter(item => item.value !== null).length >= 2)),
});

const timeline = z.object({
  type: z.literal('timeline'), title, caption, unit,
  domain: z.optional(z.tuple([z.number(), z.number()])),
  items: z.array(z.object({ ...numericItem, start: z.number(), end: z.optional(z.number()) })
    .check(z.refine(item => item.end === undefined || item.end >= item.start)))
    .check(z.minLength(1), z.maxLength(ANSWER_VISUAL_LIMITS.timeline)),
}).check(z.refine(({ domain, items }) => !domain || (domain[0] < domain[1]
  && items.every(item => item.start >= domain[0] && (item.end ?? item.start) <= domain[1]))));

const answerVisual = z.discriminatedUnion('type', [metrics, bar, line, timeline]);
export type AnswerVisualData = z.infer<typeof answerVisual>;

export function parseAnswerVisual(source: string): AnswerVisualData | null {
  if (source.length > 24_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  const parsed = answerVisual.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const numberFormat = new Intl.NumberFormat('en', { maximumSignificantDigits: 21 });

export function formatVisualNumber(value: number): string {
  return Math.abs(value) >= 1e15 || (value !== 0 && Math.abs(value) < 0.0001)
    ? value.toString()
    : numberFormat.format(value);
}

export function visualFraction(value: number, low: number, high: number): number {
  if (low === high) return 0.5;
  const span = high - low;
  // Halve extreme endpoints before subtracting if the full span overflows.
  return Number.isFinite(span) ? (value - low) / span : (value / 2 - low / 2) / (high / 2 - low / 2);
}
