-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('EWC', 'ENC');

-- AlterTable
ALTER TABLE "TranslationOrder" ADD COLUMN     "event" "EventType" NOT NULL DEFAULT 'EWC';

-- CreateIndex
CREATE INDEX "TranslationOrder_event_idx" ON "TranslationOrder"("event");

-- CreateIndex
CREATE INDEX "TranslationOrder_type_idx" ON "TranslationOrder"("type");

-- CreateIndex
CREATE INDEX "TranslationOrder_status_idx" ON "TranslationOrder"("status");

-- CreateIndex
CREATE INDEX "TranslationOrder_priority_idx" ON "TranslationOrder"("priority");
