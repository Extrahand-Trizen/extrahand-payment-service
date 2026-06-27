require('dotenv').config();
const { toAdminBankAccount } = require('./src/services/bankAccountSecrets');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.POSTGRESDB_URI;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const acc = await prisma.bankAccount.findFirst({
    where: { userId: '3vsCkBGveYdBOQi2PFYLA1yXYcf1' }
  });
  console.log('Original DB Record:', acc);
  if (acc) {
    const processed = toAdminBankAccount(acc);
    console.log('Processed toAdminBankAccount Result:', processed);
  }
  await prisma.$disconnect();
}

main().catch(console.error);
