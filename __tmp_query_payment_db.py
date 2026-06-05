import os
from pathlib import Path
from psycopg2.extras import RealDictCursor
import psycopg2

# Load environment variables from .env
env_path = Path('.env')
with env_path.open() as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line:
            key, val = line.split('=', 1)
            os.environ.setdefault(key, val)

uri = os.environ.get('POSTGRESDB_URI')
if not uri:
    raise SystemExit('POSTGRESDB_URI not set')

conn = psycopg2.connect(uri)
cur = conn.cursor(cursor_factory=RealDictCursor)
cur.execute("select table_schema, table_name from information_schema.tables where table_type='BASE TABLE' and table_schema='public' order by table_name")
tables = cur.fetchall()
print('TABLES=' + str(len(tables)))
for t in tables:
    table_name = t['table_name']
    cur.execute(f'select count(*) as count from public."{table_name}"')
    cnt = cur.fetchone()['count']
    print(f'{table_name}: {cnt}')
cur.close()
conn.close()
