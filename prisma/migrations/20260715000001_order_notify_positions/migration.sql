-- Per-order email audience: which translator positions get the source-ready email.
ALTER TABLE "TranslationOrder"
  ADD COLUMN "notifyPositions" TEXT[] NOT NULL DEFAULT '{}';
