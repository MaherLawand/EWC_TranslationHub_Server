-- Per-vendor delivery links. Existing rows get vendor = '' (a shared "General"
-- set visible to everyone who can see the order), so no data is lost and the old
-- one-link-per-language behaviour is preserved.
ALTER TABLE "BroadcastDelivery" ADD COLUMN "vendor" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MarketingDelivery" ADD COLUMN "vendor" TEXT NOT NULL DEFAULT '';

-- Uniqueness now includes the vendor, so each vendor can hold its own link per
-- language. The originals were unique INDEXes (not table constraints), so they're
-- dropped as indexes.
DROP INDEX "BroadcastDelivery_broadcastId_language_key";
CREATE UNIQUE INDEX "BroadcastDelivery_broadcastId_language_vendor_key"
  ON "BroadcastDelivery"("broadcastId", "language", "vendor");

DROP INDEX "MarketingDelivery_marketingId_language_key";
CREATE UNIQUE INDEX "MarketingDelivery_marketingId_language_vendor_key"
  ON "MarketingDelivery"("marketingId", "language", "vendor");
