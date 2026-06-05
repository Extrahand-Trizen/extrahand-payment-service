-- Rename legacy walletRole value customer -> poster (additive, no deletes).
-- Safe to run multiple times.

UPDATE "public"."ExtraCoinWallet"
SET "walletRole" = 'poster'
WHERE "walletRole" = 'customer';

UPDATE "public"."ExtraCoinTransaction"
SET "walletRole" = 'poster'
WHERE "walletRole" = 'customer';
