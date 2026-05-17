/*
  Warnings:

  - You are about to drop the column `deliveredLink` on the `MarketingDetails` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "MarketingDetails" DROP COLUMN "deliveredLink",
ADD COLUMN     "sourceLanguage" TEXT[],
ADD COLUMN     "targetLanguages" TEXT[];

-- CreateTable
CREATE TABLE "MarketingDelivery" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "deliveryLink" TEXT,
    "marketingId" TEXT NOT NULL,

    CONSTRAINT "MarketingDelivery_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MarketingDelivery" ADD CONSTRAINT "MarketingDelivery_marketingId_fkey" FOREIGN KEY ("marketingId") REFERENCES "MarketingDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
