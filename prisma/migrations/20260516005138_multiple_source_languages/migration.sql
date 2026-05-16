/*
  Warnings:

  - The `sourceLanguage` column on the `BroadcastDetails` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "BroadcastDetails" DROP COLUMN "sourceLanguage",
ADD COLUMN     "sourceLanguage" TEXT[];
