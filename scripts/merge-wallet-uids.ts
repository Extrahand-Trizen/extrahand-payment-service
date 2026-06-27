/**
 * Merge ExtraCoinWallet rows keyed by Mongo ObjectId into Firebase uid wallets.
 * Run on staging clone first. Requires POSTGRESDB_URI.
 *
 * Run: npx ts-node scripts/merge-wallet-uids.ts
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma';

dotenv.config();

const OBJECT_ID = /^[a-f0-9]{24}$/i;

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.warn('MONGODB_URI not set — only listing ObjectId wallets');
  } else {
    await mongoose.connect(mongoUri);
  }

  const wallets = await prisma.extraCoinWallet.findMany();
  const objectIdWallets = wallets.filter((w) => OBJECT_ID.test(w.userId));

  console.log(`Found ${objectIdWallets.length} wallets with ObjectId userId`);

  if (!mongoose.connection.readyState) {
    await prisma.$disconnect();
    return;
  }

  const profiles = mongoose.connection.collection('profiles');
  let merged = 0;

  for (const orphan of objectIdWallets) {
    const profile = await profiles.findOne({ _id: new mongoose.Types.ObjectId(orphan.userId) });
    const uid = profile?.uid as string | undefined;
    if (!uid || uid === orphan.userId) continue;

    const canonical = await prisma.extraCoinWallet.findUnique({ where: { userId: uid } });

    await prisma.$transaction(async (tx) => {
      await tx.extraCoinTransaction.updateMany({
        where: { userId: orphan.userId },
        data: { userId: uid },
      });

      if (canonical) {
        await tx.extraCoinWallet.update({
          where: { userId: uid },
          data: {
            balanceCoins: { increment: orphan.balanceCoins },
            balanceRupees: { increment: orphan.balanceRupees },
            lifetimeEarnedCoins: { increment: orphan.lifetimeEarnedCoins },
            lifetimeUsedCoins: { increment: orphan.lifetimeUsedCoins },
            lastUpdatedAt: new Date(),
          },
        });
        await tx.extraCoinWallet.delete({ where: { userId: orphan.userId } });
      } else {
        await tx.extraCoinWallet.update({
          where: { userId: orphan.userId },
          data: { userId: uid },
        });
      }
    });

    merged += 1;
    console.log(`Merged wallet ${orphan.userId} -> ${uid}`);
  }

  console.log(`Merged ${merged} wallets`);
  await mongoose.disconnect();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
