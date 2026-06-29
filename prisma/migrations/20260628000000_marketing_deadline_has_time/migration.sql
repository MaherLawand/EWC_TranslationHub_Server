-- AlterTable: marketing deadlines may carry a specific time-of-day (else date-only).
ALTER TABLE "MarketingDetails" ADD COLUMN "deadlineHasTime" BOOLEAN NOT NULL DEFAULT false;
