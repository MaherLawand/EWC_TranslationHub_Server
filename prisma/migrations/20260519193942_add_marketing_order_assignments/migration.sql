-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ASSIGNED_TO_ORDER';

-- CreateTable
CREATE TABLE "MarketingOrderAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketingId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingOrderAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingOrderAssignment_userId_idx" ON "MarketingOrderAssignment"("userId");

-- CreateIndex
CREATE INDEX "MarketingOrderAssignment_marketingId_idx" ON "MarketingOrderAssignment"("marketingId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingOrderAssignment_userId_marketingId_key" ON "MarketingOrderAssignment"("userId", "marketingId");

-- AddForeignKey
ALTER TABLE "MarketingOrderAssignment" ADD CONSTRAINT "MarketingOrderAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingOrderAssignment" ADD CONSTRAINT "MarketingOrderAssignment_marketingId_fkey" FOREIGN KEY ("marketingId") REFERENCES "MarketingDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
