CREATE INDEX CONCURRENTLY IF NOT EXISTS "Escrow_posterUid_createdAt_idx"
  ON "Escrow" ("posterUid", "createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Escrow_performerUid_createdAt_idx"
  ON "Escrow" ("performerUid", "createdAt" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PerformerCancellationPenalty_performerUid_status_createdAt_idx"
  ON "PerformerCancellationPenalty" ("performerUid", "status", "createdAt" DESC);
