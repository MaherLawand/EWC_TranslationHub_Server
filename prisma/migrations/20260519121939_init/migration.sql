/*
  Warnings:

  - You are about to drop the column `deliveryFormat` on the `BroadcastDetails` table. All the data in the column will be lost.
  - You are about to drop the column `deliveryFormat` on the `MarketingDetails` table. All the data in the column will be lost.
  - You are about to drop the `TranslationDelivery` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[marketingId,language]` on the table `MarketingDelivery` will be added. If there are existing duplicate values, this will fail.
  - Made the column `gameId` on table `BroadcastDetails` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "BroadcastDetails" DROP CONSTRAINT "BroadcastDetails_gameId_fkey";

-- DropForeignKey
ALTER TABLE "TranslationDelivery" DROP CONSTRAINT "TranslationDelivery_broadcastId_fkey";

-- AlterTable
ALTER TABLE "BroadcastDetails" DROP COLUMN "deliveryFormat",
ALTER COLUMN "gameId" SET NOT NULL,
ALTER COLUMN "sourceFileLink" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "MarketingDetails" DROP COLUMN "deliveryFormat",
ALTER COLUMN "sourceFileLink" DROP NOT NULL;

-- DropTable
DROP TABLE "TranslationDelivery";

-- CreateTable
CREATE TABLE "BroadcastDelivery" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "deliveryLink" TEXT,
    "broadcastId" TEXT NOT NULL,

    CONSTRAINT "BroadcastDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastDeliveryFormat" (
    "id" TEXT NOT NULL,
    "format" "DeliveryFormat" NOT NULL,
    "deliveryLink" TEXT,
    "broadcastId" TEXT NOT NULL,

    CONSTRAINT "BroadcastDeliveryFormat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingDeliveryFormat" (
    "id" TEXT NOT NULL,
    "format" "DeliveryFormat" NOT NULL,
    "deliveryLink" TEXT,
    "marketingId" TEXT NOT NULL,

    CONSTRAINT "MarketingDeliveryFormat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BroadcastDelivery_broadcastId_idx" ON "BroadcastDelivery"("broadcastId");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastDelivery_broadcastId_language_key" ON "BroadcastDelivery"("broadcastId", "language");

-- CreateIndex
CREATE INDEX "BroadcastDeliveryFormat_broadcastId_idx" ON "BroadcastDeliveryFormat"("broadcastId");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastDeliveryFormat_broadcastId_format_key" ON "BroadcastDeliveryFormat"("broadcastId", "format");

-- CreateIndex
CREATE INDEX "MarketingDeliveryFormat_marketingId_idx" ON "MarketingDeliveryFormat"("marketingId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingDeliveryFormat_marketingId_format_key" ON "MarketingDeliveryFormat"("marketingId", "format");

-- CreateIndex
CREATE INDEX "BroadcastDetails_gameId_idx" ON "BroadcastDetails"("gameId");

-- CreateIndex
CREATE INDEX "BroadcastDetails_deliveryDate_idx" ON "BroadcastDetails"("deliveryDate");

-- CreateIndex
CREATE INDEX "BroadcastDetails_deadlineDate_idx" ON "BroadcastDetails"("deadlineDate");

-- CreateIndex
CREATE INDEX "Game_name_idx" ON "Game"("name");

-- CreateIndex
CREATE INDEX "GameAssignment_userId_idx" ON "GameAssignment"("userId");

-- CreateIndex
CREATE INDEX "GameAssignment_gameId_idx" ON "GameAssignment"("gameId");

-- CreateIndex
CREATE INDEX "MarketingDelivery_marketingId_idx" ON "MarketingDelivery"("marketingId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingDelivery_marketingId_language_key" ON "MarketingDelivery"("marketingId", "language");

-- CreateIndex
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");

-- CreateIndex
CREATE INDEX "Notification_orderId_idx" ON "Notification"("orderId");

-- CreateIndex
CREATE INDEX "Notification_isRead_idx" ON "Notification"("isRead");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "TranslationOrder_createdById_idx" ON "TranslationOrder"("createdById");

-- CreateIndex
CREATE INDEX "TranslationOrder_completedById_idx" ON "TranslationOrder"("completedById");

-- CreateIndex
CREATE INDEX "TranslationOrder_lastEditedById_idx" ON "TranslationOrder"("lastEditedById");

-- CreateIndex
CREATE INDEX "TranslationOrder_dateAdded_idx" ON "TranslationOrder"("dateAdded");

-- CreateIndex
CREATE INDEX "TranslationOrder_event_status_idx" ON "TranslationOrder"("event", "status");

-- CreateIndex
CREATE INDEX "TranslationOrder_type_status_idx" ON "TranslationOrder"("type", "status");

-- CreateIndex
CREATE INDEX "TranslationOrderEdit_orderId_idx" ON "TranslationOrderEdit"("orderId");

-- CreateIndex
CREATE INDEX "TranslationOrderEdit_editedById_idx" ON "TranslationOrderEdit"("editedById");

-- CreateIndex
CREATE INDEX "TranslationOrderEdit_editedAt_idx" ON "TranslationOrderEdit"("editedAt");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_department_idx" ON "User"("department");

-- CreateIndex
CREATE INDEX "User_position_idx" ON "User"("position");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- AddForeignKey
ALTER TABLE "BroadcastDetails" ADD CONSTRAINT "BroadcastDetails_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastDelivery" ADD CONSTRAINT "BroadcastDelivery_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "BroadcastDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastDeliveryFormat" ADD CONSTRAINT "BroadcastDeliveryFormat_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "BroadcastDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDeliveryFormat" ADD CONSTRAINT "MarketingDeliveryFormat_marketingId_fkey" FOREIGN KEY ("marketingId") REFERENCES "MarketingDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
