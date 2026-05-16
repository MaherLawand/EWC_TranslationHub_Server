-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "UserDepartment" AS ENUM ('BROADCAST', 'MARKETING');

-- CreateEnum
CREATE TYPE "UserPosition" AS ENUM ('PRODUCER', 'POST_PRODUCTION_MANAGER', 'TRANSLATOR');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('BROADCAST', 'MARKETING');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "DeliveryFormat" AS ENUM ('TEXT', 'SRT', 'BURNED_IN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "department" "UserDepartment",
    "position" "UserPosition",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "inviteToken" TEXT,
    "inviteExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslationOrder" (
    "id" TEXT NOT NULL,
    "type" "OrderType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "dateAdded" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastDetails" (
    "id" TEXT NOT NULL,
    "gameId" TEXT,
    "estimatedMinutes" INTEGER NOT NULL,
    "sourceLanguage" TEXT NOT NULL,
    "targetLanguages" TEXT[],
    "deliveryFormat" "DeliveryFormat" NOT NULL,
    "sourceFileLink" TEXT NOT NULL,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "deadlineDate" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "BroadcastDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingDetails" (
    "id" TEXT NOT NULL,
    "sourceFileLink" TEXT NOT NULL,
    "deliveredLink" TEXT,
    "deliveryFormat" "DeliveryFormat" NOT NULL,
    "orderId" TEXT NOT NULL,

    CONSTRAINT "MarketingDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslationDelivery" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "deliveryLink" TEXT,
    "broadcastId" TEXT NOT NULL,

    CONSTRAINT "TranslationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Game_name_key" ON "Game"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastDetails_orderId_key" ON "BroadcastDetails"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingDetails_orderId_key" ON "MarketingDetails"("orderId");

-- AddForeignKey
ALTER TABLE "TranslationOrder" ADD CONSTRAINT "TranslationOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastDetails" ADD CONSTRAINT "BroadcastDetails_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastDetails" ADD CONSTRAINT "BroadcastDetails_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TranslationOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDetails" ADD CONSTRAINT "MarketingDetails_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "TranslationOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranslationDelivery" ADD CONSTRAINT "TranslationDelivery_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "BroadcastDetails"("id") ON DELETE CASCADE ON UPDATE CASCADE;
