-- Add status-transition timestamps to TranslationOrder.
ALTER TABLE "TranslationOrder" ADD COLUMN "readyAt" TIMESTAMP(3);
ALTER TABLE "TranslationOrder" ADD COLUMN "inProgressAt" TIMESTAMP(3);
