import { Migration } from '@mikro-orm/migrations';

export class Migration20260829230119 extends Migration {

  override name = 'Migration20260829230119';

  override up(): void | Promise<void> {
    this.addSql(`drop index "wt_pending_reference_idx";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wt_failure_code_consistency_ck";`);
    this.addSql(`alter table "wager_transactions" add "reference_retry_attempts" int not null default 0, add "next_reference_retry_at" timestamptz null;`);
    this.addSql(`create index "wt_pending_reference_idx" on "wager_transactions" ("next_reference_retry_at", "created_at") where "status" = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_failure_code_consistency_ck" check (((status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL) OR (status NOT IN ('REJECTED','FAILED') AND failure_code IS NULL)));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "wt_pending_reference_idx";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wt_failure_code_consistency_ck";`);
    this.addSql(`alter table "wager_transactions" drop column "reference_retry_attempts", drop column "next_reference_retry_at";`);
    this.addSql(`create index "wt_pending_reference_idx" on "wager_transactions" ("created_at") where status = 'PENDING_REFERENCE'::text;`);
    this.addSql(`alter table "wager_transactions" add constraint "wt_failure_code_consistency_ck" check (((status = ANY (ARRAY['REJECTED'::text, 'FAILED'::text])) AND (failure_code IS NOT NULL)) OR ((status <> ALL (ARRAY['REJECTED'::text, 'FAILED'::text])) AND (failure_code IS NULL)));`);
  }

}