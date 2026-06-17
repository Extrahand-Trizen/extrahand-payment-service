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

# Load environment variables from the local .env file
root = Path(__file__).resolve().parent
env_path = root / '.env'
if env_path.exists():
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

try:
    cur.execute('BEGIN')

    def load_ids(query, args):
        cur.execute(query, args)
        return [row['id'] for row in cur.fetchall()]

    keep_transaction_ids = load_ids(
        'SELECT "id" FROM "Transaction" WHERE "razorpayPaymentId" = ANY(%s)',
        (PAYMENT_IDS,),
    )
    keep_escrow_ids = load_ids(
        'SELECT "id" FROM "Escrow" WHERE "razorpayPaymentId" = ANY(%s)',
        (PAYMENT_IDS,),
    )

    keep_payout_ids = load_ids(
        'SELECT "id" FROM "Payout" WHERE "escrowId" = ANY(%s) OR "transactionId" = ANY(%s)',
        (keep_escrow_ids, keep_transaction_ids),
    )
    keep_refund_ids = load_ids(
        'SELECT "id" FROM "Refund" WHERE "escrowId" = ANY(%s) OR "transactionId" = ANY(%s) OR "paymentId" = ANY(%s)',
        (keep_escrow_ids, keep_transaction_ids, PAYMENT_IDS),
    )

    print('Keep counts:')
    print('  Transaction rows:', len(keep_transaction_ids))
    print('  Escrow rows:', len(keep_escrow_ids))
    print('  Payout rows:', len(keep_payout_ids))
    print('  Refund rows:', len(keep_refund_ids))

    # Delete unrelated child rows first
    cur.execute(
        'DELETE FROM "Ledger" WHERE '
        '(COALESCE("escrowId", \'\') NOT IN %s) '
        'AND (COALESCE("paymentTransactionId", \'\') NOT IN %s) '
        'AND (COALESCE("payoutId", \'\') NOT IN %s) '
        'AND (COALESCE("refundId", \'\') NOT IN %s) '
        'AND (COALESCE("razorpayPaymentId", \'\') NOT IN %s)',
        (tuple(keep_escrow_ids) or ('',), tuple(keep_transaction_ids) or ('',), tuple(keep_payout_ids) or ('',), tuple(keep_refund_ids) or ('',), tuple(PAYMENT_IDS)),
    )
    print('Deleted Ledger rows:', cur.rowcount)

    cur.execute(
        'DELETE FROM "Payout" WHERE '
        '(COALESCE("escrowId", \'\') NOT IN %s) '
        'AND (COALESCE("transactionId", \'\') NOT IN %s)',
        (tuple(keep_escrow_ids) or ('',), tuple(keep_transaction_ids) or ('',)),
    )
    print('Deleted Payout rows:', cur.rowcount)

    cur.execute(
        'DELETE FROM "Refund" WHERE '
        '(COALESCE("escrowId", \'\') NOT IN %s) '
        'AND (COALESCE("transactionId", \'\') NOT IN %s) '
        'AND (COALESCE("paymentId", \'\') NOT IN %s)',
        (tuple(keep_escrow_ids) or ('',), tuple(keep_transaction_ids) or ('',), tuple(PAYMENT_IDS)),
    )
    print('Deleted Refund rows:', cur.rowcount)

    cur.execute(
        'DELETE FROM "Transaction" WHERE "razorpayPaymentId" IS NULL OR "razorpayPaymentId" NOT IN %s',
        (tuple(PAYMENT_IDS),),
    )
    print('Deleted Transaction rows:', cur.rowcount)

    cur.execute(
        'DELETE FROM "Escrow" WHERE "razorpayPaymentId" IS NULL OR "razorpayPaymentId" NOT IN %s',
        (tuple(PAYMENT_IDS),),
    )
    print('Deleted Escrow rows:', cur.rowcount)

    unrelated_tables = [
        'AdminInvite',
        'AdminUser',
        'AuditLog',
        'BankAccount',
        'CategoryFeeConfig',
        'Dispute',
        'ExtraCoinTransaction',
        'ExtraCoinWallet',
        'JobQueue',
        'PaymentOrderIdempotency',
        'PerformerCancellationPenalty',
        'Reconciliation',
        'SystemConfig',
        'UserPaymentProfile',
    ]

    cur.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY(%s)",
        (unrelated_tables,),
    )
    existing = [row['tablename'] for row in cur.fetchall()]
    for table in existing:
        cur.execute(f'TRUNCATE TABLE "{table}" RESTART IDENTITY CASCADE')
        print(f'Truncated {table}')

    conn.commit()
    print('COMMIT successful')
except Exception as e:
    conn.rollback()
    print('ROLLBACK due to:', e)
    raise
finally:
    cur.close()
    conn.close()
