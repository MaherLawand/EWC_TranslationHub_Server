-- Add vendor translator positions. Enum ADD VALUE must run outside a transaction
-- and in its own migration before any statement uses the new values.
ALTER TYPE "UserPosition" ADD VALUE IF NOT EXISTS 'TRANSPERFECT';
ALTER TYPE "UserPosition" ADD VALUE IF NOT EXISTS 'TARJAMA';
