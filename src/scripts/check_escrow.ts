import { prisma } from '../config/prisma';

async function main() {
  try {
    const escrowId = 'escrow_1782285701729_mepx6qz';
    const escrow = await prisma.escrow.findFirst({
      where: {
        OR: [
          { escrowId },
          { id: escrowId }
        ]
      }
    });
    console.log('Escrow query result:', JSON.stringify(escrow, null, 2));
  } catch (error) {
    console.error('Error querying escrow:', error);
  } finally {
    process.exit(0);
  }
}

main();
