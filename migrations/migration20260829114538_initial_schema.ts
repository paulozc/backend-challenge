import { Migration } from '@mikro-orm/migrations';

export class Migration20260829114538_initial_schema extends Migration {

  override name = 'Migration20260829114538_initial_schema';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("message_id" varchar(255) not null, "consumer_name" varchar(255) not null, "payload_hash" varchar(255) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("message_id", "consumer_name"));`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(255) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_pending_idx" on "outbox_messages" ("occurred_at") where "published_at" is null;`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" varchar(3) not null, "balance_amount" numeric(19,2) not null, "version" int not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_uq" unique ("player_id", "currency");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(255) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(255) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" text not null, "currency" varchar(3) not null, "money_amount" numeric(19,2) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" text not null, "failure_code" varchar(255) null, "created_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "wt_pending_reference_idx" on "wager_transactions" ("created_at") where "status" = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_idempotency_key_uq" unique ("idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_provider_external_uq" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`create unique index "wt_unique_refund_per_reference_idx" on "wager_transactions" ("reference_transaction_id") where "kind" = 'REFUND' and "status" = 'PROCESSED';`);
    this.addSql(`create unique index "wt_unique_rollback_per_reference_idx" on "wager_transactions" ("reference_transaction_id") where "kind" = 'ROLLBACK' and "status" = 'PROCESSED';`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "currency" varchar(3) not null, "money_amount" numeric(19,2) not null, "balance_before_amount" numeric(19,2) not null, "balance_after_amount" numeric(19,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wle_wallet_cursor_idx" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);

    this.addSql(`alter table "inbox_messages" add constraint "inbox_processed_after_received_ck" check (processed_at IS NULL OR processed_at >= received_at);`);
    this.addSql(`create or replace function "inbox_messages_inbox_no_reprocess_fn"() returns trigger as \$\$ begin IF OLD.processed_at IS NOT NULL THEN RAISE EXCEPTION 'mensagem %/% já foi processada em %', OLD.message_id, OLD.consumer_name, OLD.processed_at; END IF; RETURN NEW; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "inbox_no_reprocess" BEFORE UPDATE on "inbox_messages" for each ROW execute function "inbox_messages_inbox_no_reprocess_fn"();`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_attempts_non_negative_ck" check (attempts >= 0);`);
    this.addSql(`create or replace function "outbox_messages_outbox_no_mutate_after_published_fn"() returns trigger as \$\$ begin IF OLD.published_at IS NOT NULL THEN RAISE EXCEPTION 'mensagem % da outbox já foi publicada em %, não pode mais mudar', OLD.id, OLD.published_at; END IF; RETURN NEW; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "outbox_no_mutate_after_published" BEFORE UPDATE on "outbox_messages" for each ROW execute function "outbox_messages_outbox_no_mutate_after_published_fn"();`);

    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative_ck" check (balance_amount >= 0);`);
    this.addSql(`alter table "wallets" add constraint "wallets_currency_format_ck" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_positive_ck" check (version >= 1);`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete set null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_money_non_negative_ck" check (money_amount >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_reference_policy_ck" check (((kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL) OR (kind = 'WIN') OR (kind IN ('BET','LOSS','OPENING') AND reference_external_transaction_id IS NULL)));`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_processed_at_consistency_ck" check (((status = 'PROCESSED' AND processed_at IS NOT NULL) OR (status != 'PROCESSED' AND processed_at IS NULL)));`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_failure_code_consistency_ck" check (((status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL) OR (status NOT IN ('REJECTED','FAILED') AND failure_code IS NULL)));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wle_money_positive_ck" check (money_amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wle_balance_before_non_negative_ck" check (balance_before_amount >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wle_balance_after_non_negative_ck" check (balance_after_amount >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wle_arithmetic_balanced_ck" check (((direction = 'DEBIT' AND balance_after_amount = balance_before_amount - money_amount) OR (direction = 'CREDIT' AND balance_after_amount = balance_before_amount + money_amount)));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`);
    this.addSql(`create or replace function "wallet_ledger_entries_wle_immutable_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'wallet_ledger_entries é append-only: % não é permitido', TG_OP; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "wle_immutable" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_wle_immutable_fn"();`);

    // privilégios do app_user — a ROLE em si é provisionada fora da migration (infraestrutura de
    // cluster, ver docker/postgres-init/), porque uma migration não deve depender de credenciais.
    // princípio do menor privilégio: SELECT/INSERT/UPDATE em todas, DELETE em nenhuma, e
    // wallet_ledger_entries sem UPDATE/DELETE (imutabilidade, camada 1 — a camada 2 é o trigger acima).
    this.addSql(`grant select, insert, update on "wallets" to app_user;`);
    this.addSql(`grant select, insert, update on "wager_transactions" to app_user;`);
    this.addSql(`grant select, insert, update on "inbox_messages" to app_user;`);
    this.addSql(`grant select, insert, update on "outbox_messages" to app_user;`);
    this.addSql(`grant select, insert on "wallet_ledger_entries" to app_user;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_wallet_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_wallet_id_foreign";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);

    this.addSql(`drop trigger if exists "inbox_no_reprocess" on "inbox_messages";`);
    this.addSql(`drop function if exists "inbox_messages_inbox_no_reprocess_fn"();`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop trigger if exists "outbox_no_mutate_after_published" on "outbox_messages";`);
    this.addSql(`drop function if exists "outbox_messages_outbox_no_mutate_after_published_fn"();`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop trigger if exists "wle_immutable" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_wle_immutable_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}