-- AlterTable: flag set when an existing order's source file is changed/replaced.
ALTER TABLE "TranslationOrder" ADD COLUMN "sourceChangedAt" TIMESTAMP(3);
