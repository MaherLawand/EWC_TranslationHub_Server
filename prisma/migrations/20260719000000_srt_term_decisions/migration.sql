-- Records what a translator did with each suggested terminology change, so the
-- checker stops repeating a suggestion they have already corrected or rejected.
CREATE TABLE "SrtTermDecision" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "findText" TEXT NOT NULL,
    "suggestedText" TEXT NOT NULL,
    "finalText" TEXT,
    "outcome" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SrtTermDecision_pkey" PRIMARY KEY ("id")
);

-- One opinion per language + text + proposal; re-deciding updates it in place.
CREATE UNIQUE INDEX "SrtTermDecision_language_findText_suggestedText_key"
    ON "SrtTermDecision"("language", "findText", "suggestedText");

CREATE INDEX "SrtTermDecision_language_idx" ON "SrtTermDecision"("language");
CREATE INDEX "SrtTermDecision_decidedById_idx" ON "SrtTermDecision"("decidedById");

-- Keep the decision if the user is removed; the terminology choice outlives them.
ALTER TABLE "SrtTermDecision"
    ADD CONSTRAINT "SrtTermDecision_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
