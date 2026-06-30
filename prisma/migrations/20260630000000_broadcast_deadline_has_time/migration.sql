-- AlterTable: broadcast deadlines may carry a specific time-of-day (else date-only).
ALTER TABLE "BroadcastDetails" ADD COLUMN "deadlineHasTime" BOOLEAN NOT NULL DEFAULT false;
