-- AlterEnum
-- Adds the marketing-specific delivery formats to the shared DeliveryFormat enum.
ALTER TYPE "DeliveryFormat" ADD VALUE 'EMBEDDED_SUBS';
ALTER TYPE "DeliveryFormat" ADD VALUE 'ON_SCREEN_TEXT';
ALTER TYPE "DeliveryFormat" ADD VALUE 'GRAPHIC_TEXT';
ALTER TYPE "DeliveryFormat" ADD VALUE 'VO_TRANSLATIONS';
