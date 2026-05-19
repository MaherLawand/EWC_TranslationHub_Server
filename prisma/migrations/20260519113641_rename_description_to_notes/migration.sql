/*
  Warnings:

  - You are about to drop the column `description` on the `TranslationOrder` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "TranslationOrder" DROP COLUMN "description",
ADD COLUMN     "notes" TEXT;
