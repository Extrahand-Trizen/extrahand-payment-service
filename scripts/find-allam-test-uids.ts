import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const mongoUri = process.env.MONGODB_URI;

async function run() {
  if (!mongoUri) {
    console.error('MONGODB_URI not found');
    return;
  }
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const ProfileSchema = new mongoose.Schema({
    uid: String,
    name: String,
    email: String,
  });
  const Profile = mongoose.model('Profile', ProfileSchema);

  const users = await Profile.find({
    name: { $regex: /allam test/i }
  });

  console.log(`Found ${users.length} users matching "allam test":`);
  users.forEach((u) => {
    console.log(`- Name: "${u.name}", UID: "${u.uid}", Email: "${u.email}"`);
  });

  await mongoose.disconnect();
}

run().catch(console.error);
