const { Client } = require('pg'); 
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_zNrXeLJ7ZU2P@ep-solitary-frost-a196t8gd-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require' }); 
async function run() { 
  await client.connect(); 
  const res = await client.query('SELECT "id", "escrowId", "taskId", "bookingOrderId", "createdAt" FROM "Escrow" ORDER BY "createdAt" DESC LIMIT 5'); 
  console.log('Latest 5 Escrows:', JSON.stringify(res.rows, null, 2)); 
  const res2 = await client.query('SELECT "id", "escrowId", "taskId", "bookingOrderId" FROM "Escrow" WHERE "bookingOrderId" = \'fc545b27-3bb5-4171-9a0e-0f3381ab052b\' OR "metadata"::text LIKE \'%fc545b%\''); 
  console.log('Found matching:', JSON.stringify(res2.rows, null, 2)); 
  await client.end(); 
} 
run();
