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

for table in ['Transaction', 'Escrow', 'Refund', 'Payout', 'Ledger']:
    print(f'==== {table.upper()} ====', flush=True)
    if table == 'Ledger':
        col = 'paymentTransactionId'
    else:
        col = 'razorpayPaymentId'
    cur.execute(f'SELECT count(*) as count FROM "{table}" WHERE "{col}" = ANY(%s)', (PAYMENT_IDS,))
    print('count:', cur.fetchone()['count'])
    select_cols = ['"id"', '"' + col + '"']
    if table in ['Escrow', 'Refund', 'Payout', 'Ledger']:
        select_cols.append('"transactionId"')
        select_cols.append('"escrowId"')
    cur.execute(f'SELECT {", ".join(select_cols)} FROM "{table}" WHERE "{col}" = ANY(%s) ORDER BY "id"', (PAYMENT_IDS,))
    rows = cur.fetchall()
    for r in rows:
        print(r)
    print()

conn.close()
