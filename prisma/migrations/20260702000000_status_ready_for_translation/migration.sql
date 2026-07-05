-- AlterEnum: add a "ready for translation" status between PENDING and IN_PROGRESS.
ALTER TYPE "OrderStatus" ADD VALUE 'READY_FOR_TRANSLATION' BEFORE 'IN_PROGRESS';
