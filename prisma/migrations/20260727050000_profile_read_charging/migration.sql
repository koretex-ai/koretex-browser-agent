-- Charge one coin per profile read, rolled up into a single daily wallet entry.
ALTER TYPE "CoinTransactionType" ADD VALUE 'PROFILE_READ';
ALTER TABLE "VisitDay" ADD COLUMN "coinsCharged" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VisitDay" ADD COLUMN "coinTxId" TEXT;
