const { Client } = require('pg'); 
const devClient = new Client({ connectionString: 'postgresql://neondb_owner:npg_zNrXeLJ7ZU2P@ep-solitary-violet-a19m2bej-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require' }); 
async function run() { 
  await devClient.connect(); 
  const res2 = await devClient.query('SELECT * FROM "Escrow" WHERE "bookingOrderId" = \'fc545b27-3bb5-4171-9a0e-0f3381ab052b\''); 
  console.log(JSON.stringify(res2.rows[0], null, 2)); 
  await devClient.end(); 
} 
run().catch(console.error);
