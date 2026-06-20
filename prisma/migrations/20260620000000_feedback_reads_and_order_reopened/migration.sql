-- AlterEnum: notification raised when a completed order is reopened.
ALTER TYPE "NotificationType" ADD VALUE 'ORDER_REOPENED';

-- CreateTable: per-user read receipts for feedback messages.
CREATE TABLE "FeedbackRead" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeedbackRead_userId_idx" ON "FeedbackRead"("userId");

-- CreateIndex
CREATE INDEX "FeedbackRead_feedbackId_idx" ON "FeedbackRead"("feedbackId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRead_feedbackId_userId_key" ON "FeedbackRead"("feedbackId", "userId");

-- AddForeignKey
ALTER TABLE "FeedbackRead" ADD CONSTRAINT "FeedbackRead_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "OrderFeedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeedbackRead" ADD CONSTRAINT "FeedbackRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
