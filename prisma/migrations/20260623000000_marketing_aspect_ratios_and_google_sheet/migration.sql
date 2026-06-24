-- AlterEnum: add the GOOGLE_SHEET delivery format.
ALTER TYPE "DeliveryFormat" ADD VALUE 'GOOGLE_SHEET';

-- AlterTable: aspect ratios / sizes for marketing assets (e.g. 1x1, 4x5, 9x16, 16x9).
ALTER TABLE "MarketingDetails" ADD COLUMN "aspectRatios" TEXT[];
