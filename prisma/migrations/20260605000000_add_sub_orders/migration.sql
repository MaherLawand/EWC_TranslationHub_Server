-- AlterTable
ALTER TABLE "TranslationOrder" ADD COLUMN     "isParent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentId" TEXT;

-- CreateIndex
CREATE INDEX "TranslationOrder_parentId_idx" ON "TranslationOrder"("parentId");

-- AddForeignKey
ALTER TABLE "TranslationOrder" ADD CONSTRAINT "TranslationOrder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TranslationOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
