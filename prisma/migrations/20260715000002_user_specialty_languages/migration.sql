-- Languages a translator specializes in (routes source-file emails to matching translators).
ALTER TABLE "User"
  ADD COLUMN "specialtyLanguages" TEXT[] NOT NULL DEFAULT '{}';
