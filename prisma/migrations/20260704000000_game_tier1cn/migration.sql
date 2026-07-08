-- AlterTable: extra "Tier 1 CN" designation on games.
ALTER TABLE "Game" ADD COLUMN "tier1CN" BOOLEAN NOT NULL DEFAULT false;
