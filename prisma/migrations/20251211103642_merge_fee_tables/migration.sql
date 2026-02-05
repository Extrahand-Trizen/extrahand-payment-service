/*
  Warnings:

  - You are about to drop the `CancellationFeeDistribution` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Fee` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CancellationFeeDistribution" DROP CONSTRAINT "CancellationFeeDistribution_refundId_fkey";

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "toOtherParty" DECIMAL(12,2),
ADD COLUMN     "toPlatform" DECIMAL(12,2);

-- DropTable
DROP TABLE "CancellationFeeDistribution";

-- DropTable
DROP TABLE "Fee";
