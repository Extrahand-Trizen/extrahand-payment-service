export type RecurringPayoutDisplay = {
  recurringPlanTitle?: string;
  visitNumber?: number;
  visitId?: string;
  parentTaskId?: string;
  displayTitle: string;
};

function toPositiveInt(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

export function stripRecurringVisitTitleSuffix(title: string): string {
  return String(title || '')
    .replace(/\s*[·•]\s*Visit\s+\d+\s*$/i, '')
    .trim();
}

function parseVisitNumberFromTitle(title: string): number | undefined {
  const trimmed = String(title || '').trim();
  if (!trimmed) return undefined;
  const match =
    trimmed.match(/[·•]\s*Visit\s+(\d+)\s*$/i) || trimmed.match(/\bVisit\s+(\d+)\s*$/i);
  return match ? toPositiveInt(match[1]) : undefined;
}

function readMetaString(meta: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

export function resolveRecurringPayoutDisplay(
  ...sources: Array<Record<string, unknown> | null | undefined>
): RecurringPayoutDisplay | null {
  const merged = Object.assign({}, ...sources.filter(Boolean)) as Record<string, unknown>;

  const visitId = readMetaString(merged, ['visitId']);
  const parentTaskId = readMetaString(merged, ['parentTaskId']);
  const isRecurring =
    merged.recurringPlan === true || Boolean(visitId && parentTaskId) || Boolean(visitId);
  if (!isRecurring && !visitId) return null;

  const rawTitle = readMetaString(merged, [
    'recurringPlanTitle',
    'taskTitleSnapshot',
    'taskTitle',
  ]);

  const visitNumber =
    toPositiveInt(merged.visitNumber) ??
    toPositiveInt(merged.visitIndex) ??
    parseVisitNumberFromTitle(rawTitle);

  const planTitle = stripRecurringVisitTitleSuffix(rawTitle) || rawTitle;
  const displayTitle =
    planTitle && visitNumber
      ? `${planTitle} · Visit ${visitNumber}`
      : visitNumber
        ? `Visit ${visitNumber}`
        : planTitle || 'Payout';

  return {
    recurringPlanTitle: planTitle || undefined,
    visitNumber,
    visitId: visitId || undefined,
    parentTaskId: parentTaskId || undefined,
    displayTitle,
  };
}

export function enrichRecurringPayoutMetadata(
  base: Record<string, unknown>,
  ...sources: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
  const recurring = resolveRecurringPayoutDisplay(base, ...sources);
  if (!recurring) return base;

  return {
    ...base,
    recurringPlan: true,
    ...(recurring.parentTaskId ? { parentTaskId: recurring.parentTaskId } : {}),
    ...(recurring.visitId ? { visitId: recurring.visitId } : {}),
    ...(recurring.visitNumber ? { visitNumber: recurring.visitNumber } : {}),
    ...(recurring.recurringPlanTitle
      ? { recurringPlanTitle: recurring.recurringPlanTitle }
      : {}),
    taskTitle: recurring.displayTitle,
    taskTitleSnapshot: recurring.displayTitle,
  };
}

export function formatRecurringPayoutDescription(
  prefix: string,
  displayTitle: string,
  maxLen = 100,
): string {
  const title =
    displayTitle.length > maxLen ? `${displayTitle.slice(0, maxLen - 3)}...` : displayTitle;
  return `${prefix} — ${title}`;
}
