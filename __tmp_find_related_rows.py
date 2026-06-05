import os
from pathlib import Path
from psycopg2.extras import RealDictCursor
import psycopg2

PAYMENT_IDS = [
    'pay_SxomwcbZoOfLEI',
    'pay_SwGl2PoOBa87np',
    'pay_Sv3msshfiD2GRM',
    'pay_SunZEFZYXVlT5y',
    'pay_SsJ9vyL6tsja7i',
    'pay_SruGmRLd4In0nm',
    'pay_SrCgbW2FZjflhx',
    'pay_SrCB1O2W44kU72',
    'pay_SrCAFdUd17MSLl',
    'pay_SqpNuWzTCoGuPv',
    'pay_SpV4lIDSbUB6Ci',
    'pay_Sp8QfH7eeTYgzh',
    'pay_Sotex4MjDwy3iH',
    'pay_SotPIv6KcamDS8',
    'pay_SotEDxQGA0w5OQ',
    'pay_SotBtQuqKGB2kt',
    'pay_SoRkvcR7C5vjNK',
    'pay_Snw5OQ65X9Twwf',
    'pay_Smq4LH92sIN0Oo',
    'pay_Slz6A3z4oLGw4H',
    'pay_SlvSyq71lDgz7M',
    'pay_SleeHJz1HUq1DM',
    'pay_Slecy9kOkgi5cY',
    'pay_SjzRLtXJgdAzYo',
    'pay_SjzOm5dumRLVhg',
]

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
conn = psycopg2.connect(uri)
cur = conn.cursor(cursor_factory=RealDictCursor)

# Query matching transactions
cur.execute('SELECT "id", "razorpayPaymentId", "taskId", "userId" FROM "Transaction" WHERE "razorpayPaymentId" = ANY(%s) ORDER BY "id"', (PAYMENT_IDS,))
transactions = cur.fetchall()
print('TRANSACTIONS:', len(transactions))
for row in transactions:
    print(row)

transaction_ids = [r['id'] for r in transactions]

cur.execute('SELECT "id", "razorpayPaymentId", "escrowId", "taskId", "posterUid", "performerUid" FROM "Escrow" WHERE "razorpayPaymentId" = ANY(%s) ORDER BY "id"', (PAYMENT_IDS,))
escrows = cur.fetchall()
print('\nESCROWS:', len(escrows))
for row in escrows:
    print(row)

escrow_ids = [r['id'] for r in escrows]

for table, condition in [
    ('Ledger', '"escrowId" = ANY(%s) OR "paymentTransactionId" = ANY(%s)'),
    ('Refund', '"escrowId" = ANY(%s) OR "transactionId" = ANY(%s) OR "paymentId" = ANY(%s)'),
    ('Payout', '"escrowId" = ANY(%s) OR "transactionId" = ANY(%s)'),
]:
    print(f'\n{table}:')
    cur.execute(f'SELECT count(*) as count FROM "{table}" WHERE {condition}', (escrow_ids, transaction_ids, transaction_ids) if table == 'Refund' else (escrow_ids, transaction_ids))
    print('count:', cur.fetchone()['count'])
    cur.execute(f'SELECT * FROM "{table}" WHERE {condition} ORDER BY "id" LIMIT 20', (escrow_ids, transaction_ids, transaction_ids) if table == 'Refund' else (escrow_ids, transaction_ids))
    rows = cur.fetchall()
    for row in rows:
        print(row)

conn.close()
