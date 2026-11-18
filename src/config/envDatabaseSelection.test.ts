import assert from 'node:assert/strict';
import test from 'node:test';
import { getPostgresUriForEnvironment } from './env';

const config = {
  USE_DEV_POSTGRES: false,
  POSTGRESDB_URI: 'postgresql://legacy/production',
  PROD_POSTGRESDB_URI: 'postgresql://explicit/production',
  DEV_POSTGRESDB_URI: 'postgresql://explicit/development',
};

test('selects only the requested environment database', () => {
  assert.equal(getPostgresUriForEnvironment('production', config), config.PROD_POSTGRESDB_URI);
  assert.equal(getPostgresUriForEnvironment('development', config), config.DEV_POSTGRESDB_URI);
});

test('does not use production or legacy URI when development URI is missing', () => {
  assert.throws(
    () =>
      getPostgresUriForEnvironment('development', {
        ...config,
        DEV_POSTGRESDB_URI: undefined,
      }),
    /DEV_POSTGRESDB_URI is required/,
  );
});

test('does not treat the active development database as production', () => {
  assert.throws(
    () =>
      getPostgresUriForEnvironment('production', {
        ...config,
        USE_DEV_POSTGRES: true,
        PROD_POSTGRESDB_URI: undefined,
      }),
    /PROD_POSTGRESDB_URI is required/,
  );
});
