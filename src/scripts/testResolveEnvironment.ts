import 'dotenv/config';
import { resolvePaymentEnvironment, paymentKeys, paymentSecrets } from '../config/paymentEnvironment';
import { UserServiceClient } from '../clients/UserServiceClient';

async function main() {
  const uid = '1Ac3f3DFTnXb8BJGT4tZg1OX3TZ2'; // 9999999999
  console.log('Testing UID:', uid);
  console.log('Live Key ID:', paymentKeys.live);
  console.log('Test Key ID:', paymentKeys.test);

  // Direct database check on user-service or mock
  const isTester = await UserServiceClient.isPaymentTester(uid);
  console.log('UserServiceClient.isPaymentTester(uid):', isTester);

  const env = await resolvePaymentEnvironment(uid);
  console.log('Resolved Payment Environment:', env);

  const randomUid = 'non-tester-uid-' + Date.now();
  const randomEnv = await resolvePaymentEnvironment(randomUid);
  console.log('Random User Resolved Payment Environment:', randomEnv);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

