-- Rename the old enum so we can create a fresh one with the right values
ALTER TYPE "UserRole" RENAME TO "UserRole_old";

-- Create new enum with only ADMIN and USER
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- Drop the default before changing column type
ALTER TABLE "User" ALTER COLUMN role DROP DEFAULT;

-- Migrate the column: keep ADMIN, convert EDITOR/VIEWER → USER
ALTER TABLE "User"
  ALTER COLUMN role TYPE "UserRole"
  USING CASE
    WHEN role::text = 'ADMIN' THEN 'ADMIN'::"UserRole"
    ELSE 'USER'::"UserRole"
  END;

-- Restore default
ALTER TABLE "User" ALTER COLUMN role SET DEFAULT 'USER'::"UserRole";

-- Drop the old enum
DROP TYPE "UserRole_old";
