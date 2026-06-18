-- AlterTable: production tier (1 = highest, 3 = lowest), default 3.
ALTER TABLE "Game" ADD COLUMN "tier" INTEGER NOT NULL DEFAULT 3;

-- CreateIndex
CREATE INDEX "Game_tier_idx" ON "Game"("tier");

-- Seed tiers for existing games (anything not listed stays at the default 3).
UPDATE "Game" SET "tier" = 1
WHERE "name" IN (
  'League of Legends',
  'Counter-Strike 2',
  'Valorant',
  'Mobile Legends: Bang Bang'
);

UPDATE "Game" SET "tier" = 2
WHERE "name" IN (
  'Dota 2',
  'Honor of Kings',
  'Pubg Mobile',
  'Crossfire',
  'Pubg Battlegrounds',
  'Street Fighter 6'
);
