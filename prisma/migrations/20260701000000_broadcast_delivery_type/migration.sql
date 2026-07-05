-- CreateEnum
CREATE TYPE "DeliveryType" AS ENUM ('FINISHED', 'RAW');

-- AlterTable: broadcast deliverable is finished (SRT/burned-in) or raw (SRT only).
ALTER TABLE "BroadcastDetails" ADD COLUMN "deliveryType" "DeliveryType";
