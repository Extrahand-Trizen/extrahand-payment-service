/**
 * Immutable commercial snapshot stored on Escrow.metadata at create time.
 * Enables receipts/history/invoices when the task document is deleted or renamed later.
 */

export const ESCROW_SNAPSHOT_VERSION = 1;
export const MAX_TASK_TITLE_SNAPSHOT_LEN = 500;
export const MAX_TASK_DESCRIPTION_SNAPSHOT_LEN = 2000;

export function normalizeTaskTitleSnapshot(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t.length) return undefined;
  return t.length > MAX_TASK_TITLE_SNAPSHOT_LEN ? t.slice(0, MAX_TASK_TITLE_SNAPSHOT_LEN) : t;
}

function normalizeCategorySnapshot(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t.length) return undefined;
  return t.length > 200 ? t.slice(0, 200) : t;
}

function normalizeDescriptionSnapshot(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t.length) return undefined;
  return t.length > MAX_TASK_DESCRIPTION_SNAPSHOT_LEN
    ? t.slice(0, MAX_TASK_DESCRIPTION_SNAPSHOT_LEN)
    : t;
}

export type EscrowSnapshotMergeOptions = {
  taskCategory?: string | null;
};

function normalizePersonNameSnapshot(raw: unknown, maxLen = 200): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t.length) return undefined;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

/**
 * Merges client metadata with server-enforced snapshot fields (version, capturedAt, title/category aliases).
 */
export function buildEscrowMetadataSnapshot(
  metadata: Record<string, unknown>,
  opts: EscrowSnapshotMergeOptions
): Record<string, unknown> {
  const title =
    normalizeTaskTitleSnapshot(metadata.taskTitleSnapshot) ??
    normalizeTaskTitleSnapshot(metadata.taskTitle);

  const categoryFromOpts = normalizeCategorySnapshot(opts.taskCategory);
  const categorySlugFromMeta = normalizeCategorySnapshot(metadata.categorySlug);
  const categoryFromMeta =
    normalizeCategorySnapshot(metadata.taskCategorySnapshot) ??
    normalizeCategorySnapshot(metadata.taskCategory);
  const category = categorySlugFromMeta ?? categoryFromOpts ?? categoryFromMeta;

  const description = normalizeDescriptionSnapshot(metadata.taskDescription);

  const performerName =
    normalizePersonNameSnapshot(metadata.performerNameSnapshot) ??
    normalizePersonNameSnapshot(metadata.performerName) ??
    normalizePersonNameSnapshot(metadata.taskerName) ??
    normalizePersonNameSnapshot(metadata.assigneeName) ??
    normalizePersonNameSnapshot(metadata.helperName);
  const posterName =
    normalizePersonNameSnapshot(metadata.posterNameSnapshot) ??
    normalizePersonNameSnapshot(metadata.posterName) ??
    normalizePersonNameSnapshot(metadata.customerName) ??
    normalizePersonNameSnapshot(metadata.requesterName);

  return {
    ...metadata,
    ...(title
      ? {
          taskTitle: title,
          taskTitleSnapshot: title,
        }
      : {}),
    ...(category
      ? {
          taskCategory: category,
          taskCategorySnapshot: category,
          categorySlug: categorySlugFromMeta ?? category,
        }
      : {}),
    ...(description ? { taskDescription: description } : {}),
    ...(performerName
      ? {
          performerName,
          performerNameSnapshot: performerName,
          taskerName: performerName,
          assigneeName: performerName,
        }
      : {}),
    ...(posterName
      ? {
          posterName,
          posterNameSnapshot: posterName,
          customerName: posterName,
          requesterName: posterName,
        }
      : {}),
    snapshotVersion: ESCROW_SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Display title for emails/notifications from persisted escrow row.
 */
export function getTaskDisplayTitleFromEscrow(escrow: {
  taskId: string;
  metadata?: unknown;
}): string {
  const m =
    escrow.metadata && typeof escrow.metadata === 'object' && !Array.isArray(escrow.metadata)
      ? (escrow.metadata as Record<string, unknown>)
      : {};
  const t =
    (typeof m.taskTitleSnapshot === 'string' && m.taskTitleSnapshot.trim()) ||
    (typeof m.taskTitle === 'string' && m.taskTitle.trim()) ||
    '';
  return t || `Task ${escrow.taskId}`;
}
