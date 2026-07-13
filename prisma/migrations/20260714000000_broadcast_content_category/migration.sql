-- CreateEnum
CREATE TYPE "ContentCategory" AS ENUM ('RAW', 'OPENER', 'HYPE_PROMO', 'ENGAGEMENT', 'LONG_FORM', 'EXPLAINER');

-- AlterTable
ALTER TABLE "BroadcastDetails" ADD COLUMN "contentCategory" "ContentCategory";
