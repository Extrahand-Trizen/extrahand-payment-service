import mongoose from 'mongoose';
import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { isEscrowActiveHeldRecord } from '../utils/escrowPaymentState';

/** Recurring fields of a task document (shared Mongo `tasks` collection). */
export type TaskRecurringRef = {
  parentTaskId?: string;
  recurringVisitId?: string;
  /** Task-level assignee uid / profile id. */
  assignees: string[];
  /** The task is a recurring visit plan (Work) whose visits are paid one by one. */
  recurringPlan: boolean;
  /** Plan-level helper, used only when the visit row has no assignee of its own. */
  planAssignees: string[];
};

/** A visit row of a recurring plan (RecurringVisit collection, embedded schedule or child task). */
export type PlanVisitRef = { assignees: string[] };

/**
 * Both loaders return `undefined` when the task store cannot be read and `null` when the
 * record does not exist, so callers can fail closed on "unknown" without treating it as "absent".
 */
export type RecurringPayoutTaskStore = {
  loadTask(taskId: string): Promise<TaskRecurringRef | null | undefined>;
  loadPlanVisit(parentTaskId: string, visitId: string): Promise<PlanVisitRef | null | undefined>;
};

const str = (value: unknown): string => (value == null ? '' : String(value).trim());
const uniq = (values: unknown[]): string[] => [...new Set(values.map(str).filter(Boolean))];

function isRecurringVisitPlanDoc(doc: Record<string, any>): boolean {
  if (doc.recurringParentPlan === true) return true;
  const plan = doc.recurringPlan;
  if (plan?.visitStorage === 'collection' || plan?.planVersion === 2) return true;
  if (!doc.recurring?.enabled) return false;
  return Array.isArray(doc.schedule) && doc.schedule.some((row: any) => typeof row?.visitId === 'string');
}

export const mongoRecurringPayoutTaskStore: RecurringPayoutTaskStore = {
  async loadTask(taskId) {
    if (mongoose.connection.readyState !== 1) return undefined;
    if (!mongoose.isValidObjectId(taskId)) return null;
    try {
      const doc = await mongoose.connection.collection('tasks').findOne(
        { _id: new mongoose.Types.ObjectId(taskId) },
        {
          projection: {
            parentTaskId: 1,
            recurringVisitId: 1,
            assigneeUid: 1,
            assigneeId: 1,
            recurringParentPlan: 1,
            'recurring.enabled': 1,
            'recurringPlan.planVersion': 1,
            'recurringPlan.visitStorage': 1,
            'recurringPlan.taskerUid': 1,
            'schedule.visitId': 1,
          },
        },
      );
      if (!doc) return null;
      const assignees = uniq([doc.assigneeUid, doc.assigneeId]);
      return {
        parentTaskId: str(doc.parentTaskId) || undefined,
        recurringVisitId: str(doc.recurringVisitId) || undefined,
        assignees,
        recurringPlan: isRecurringVisitPlanDoc(doc),
        planAssignees: uniq([doc.recurringPlan?.taskerUid, ...assignees]),
      };
    } catch (error: any) {
      logger.warn('Failed to load task for recurring payout scope', { taskId, error: error?.message });
      return undefined;
    }
  },

  async loadPlanVisit(parentTaskId, visitId) {
    if (mongoose.connection.readyState !== 1) return undefined;
    if (!mongoose.isValidObjectId(parentTaskId)) return null;
    try {
      const planObjectId = new mongoose.Types.ObjectId(parentTaskId);
      const tasks = mongoose.connection.collection('tasks');
      let visit: Record<string, any> | null = await mongoose.connection
        .collection('recurringvisits')
        .findOne({ parentTaskId: planObjectId, visitId }, { projection: { assigneeUid: 1, assigneeId: 1 } });
      if (!visit) {
        const plan = await tasks.findOne(
          { _id: planObjectId, 'schedule.visitId': visitId },
          { projection: { schedule: 1 } },
        );
        visit = Array.isArray(plan?.schedule)
          ? plan!.schedule.find((row: any) => str(row?.visitId) === visitId) ?? null
          : null;
      }
      const child = await tasks.findOne(
        { parentTaskId: planObjectId, recurringVisitId: visitId },
        { projection: { assigneeUid: 1, assigneeId: 1 } },
      );
      if (!visit && !child) return null;
      return {
        assignees: uniq([visit?.assigneeUid, visit?.assigneeId, child?.assigneeUid, child?.assigneeId]),
      };
    } catch (error: any) {
      logger.warn('Failed to load recurring visit for payout scope', {
        parentTaskId,
        visitId,
        error: error?.message,
      });
      return undefined;
    }
  },
};

function isRecurringVisitEscrowMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const meta = metadata as Record<string, unknown>;
  return meta.recurringPlan === true || str(meta.visitId).length > 0;
}

/** Payment-side evidence that a task id is a recurring Work: it holds visit-scoped escrows. */
export async function taskHoldsRecurringVisitEscrows(taskId: string): Promise<boolean> {
  const rows = await prisma.escrow.findMany({
    where: { taskId },
    select: { metadata: true },
    take: 25,
  });
  return rows.some((row: { metadata: unknown }) => isRecurringVisitEscrowMetadata(row.metadata));
}

export type RecurringVisitPayoutScope =
  | { recurring: false; assignees: string[] }
  | { recurring: true; ok: false; error: string; visitId?: string }
  | { recurring: true; ok: true; parentTaskId: string; visitId: string; escrow: any };

const reject = (error: string, visitId?: string): RecurringVisitPayoutScope => ({
  recurring: true,
  ok: false,
  error,
  ...(visitId ? { visitId } : {}),
});

/**
 * Recurring status comes from task / visit data and the payment ledger, never from caller flags.
 * A recurring visit payout is authorized only by exactly one active held escrow tagged with the
 * visit's parent Work id and visit id, paid out to the helper assigned to that visit. Anything
 * that cannot be verified is rejected.
 */
export async function resolveRecurringVisitPayoutScope(
  params: { taskId: string; performerUid: string; visitId?: string; parentTaskId?: string },
  store: RecurringPayoutTaskStore = mongoRecurringPayoutTaskStore,
): Promise<RecurringVisitPayoutScope> {
  const taskId = str(params.taskId);
  const performerUid = str(params.performerUid);
  const bodyVisitId = str(params.visitId);
  const bodyParentTaskId = str(params.parentTaskId);
  const hinted = Boolean(bodyVisitId || bodyParentTaskId);
  const ref = await store.loadTask(taskId);

  let parentTaskId: string;
  let visitId: string;
  let assignees: string[];

  if (ref?.recurringVisitId && ref.parentTaskId) {
    if (bodyVisitId && bodyVisitId !== ref.recurringVisitId) {
      logger.warn('Recurring payout rejected: visit does not match child task', {
        taskId,
        bodyVisitId,
        taskVisitId: ref.recurringVisitId,
      });
      return reject('Visit does not match this task');
    }
    if (bodyParentTaskId && bodyParentTaskId !== ref.parentTaskId) {
      return reject('Recurring plan does not match this task');
    }
    parentTaskId = ref.parentTaskId;
    visitId = ref.recurringVisitId;
    assignees = ref.assignees;
  } else {
    const isPlan = Boolean(ref?.recurringPlan) || (await taskHoldsRecurringVisitEscrows(taskId));
    if (!isPlan) {
      if (hinted) {
        logger.warn('Recurring payout rejected: visit hints on a task that is not a verified recurring visit', {
          taskId,
          bodyVisitId,
          bodyParentTaskId,
          taskStoreAvailable: ref !== undefined,
        });
        return reject(
          ref === undefined ? 'Unable to verify the recurring visit for this payout' : 'Visit does not belong to this task',
        );
      }
      return { recurring: false, assignees: ref?.assignees ?? [] };
    }
    if (!bodyVisitId) {
      logger.warn('Recurring payout rejected: recurring Work without a visit id', { taskId });
      return reject('A visit is required to pay out a recurring Work');
    }
    if (bodyParentTaskId && bodyParentTaskId !== taskId) {
      return reject('Recurring plan does not match this task');
    }
    if (ref === undefined) return reject('Unable to verify the recurring visit for this payout');
    if (ref === null) return reject('Recurring Work not found');
    const visit = await store.loadPlanVisit(taskId, bodyVisitId);
    if (visit === undefined) return reject('Unable to verify the recurring visit for this payout');
    if (visit === null) {
      logger.warn('Recurring payout rejected: visit is not part of the recurring Work', {
        taskId,
        visitId: bodyVisitId,
      });
      return reject('Visit does not belong to this recurring Work');
    }
    parentTaskId = taskId;
    visitId = bodyVisitId;
    assignees = visit.assignees.length > 0 ? visit.assignees : ref.planAssignees;
  }

  if (assignees.length === 0) {
    logger.warn('Recurring payout rejected: no assigned helper on record for visit', { taskId, visitId });
    return reject('Unable to verify the helper assigned to this visit', visitId);
  }
  if (!assignees.includes(performerUid)) {
    logger.warn('Recurring payout rejected: performer is not assigned to visit', {
      taskId,
      visitId,
      performerUid,
    });
    return reject('Performer is not assigned to this visit', visitId);
  }

  const candidates = await prisma.escrow.findMany({
    where: {
      taskId: parentTaskId,
      status: 'held',
      metadata: { path: ['visitId'], equals: visitId },
    },
    orderBy: { createdAt: 'asc' },
  });
  const active = candidates.filter((row) => isEscrowActiveHeldRecord(row));
  if (active.length === 0) {
    logger.warn('Recurring payout rejected: no active payment for visit', {
      taskId,
      parentTaskId,
      visitId,
    });
    return reject('No active payment found for this visit', visitId);
  }
  if (active.length > 1) {
    logger.error('Recurring payout rejected: multiple active payments for one visit; nothing released', {
      parentTaskId,
      visitId,
      escrowIds: active.map((row) => row.escrowId),
    });
    return reject('Multiple active payments found for this visit; payout needs manual review', visitId);
  }
  const escrow = active[0];

  const escrowPerformer = str(escrow.performerUid);
  if (escrowPerformer && escrowPerformer !== 'pending_assignment' && escrowPerformer !== performerUid) {
    logger.warn('Recurring visit escrow performer is stale; using assigned helper', {
      escrowId: escrow.escrowId,
      visitId,
      escrowPerformer,
      performerUid,
    });
  }

  return { recurring: true, ok: true, parentTaskId, visitId, escrow };
}
