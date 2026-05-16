-- CreateEnum
CREATE TYPE "OrderPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "TranslationOrder" ADD COLUMN     "priority" "OrderPriority" NOT NULL DEFAULT 'MEDIUM';
