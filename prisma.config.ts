import "dotenv/config";
import { defineConfig } from "prisma/config";

const buildTimeFallback =
  "postgresql://build:build@127.0.0.1:5432/build";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // env() throws during Docker build when POSTGRESDB_URI is unset; use process.env.
    url: process.env.POSTGRESDB_URI ?? buildTimeFallback,
  },
});
