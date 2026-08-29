import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { WalletEntity } from "./src/wagering/infrastructure/persistence/entities/wallet.entity";
import { WalletLedgerEntryEntity } from "./src/wagering/infrastructure/persistence/entities/walletLedgerEntry.entity";
import { WagerTransactionEntity } from "./src/wagering/infrastructure/persistence/entities/wagerTransaction.entity";
import { InboxMessageEntity } from "./src/wagering/infrastructure/persistence/entities/inboxMessage.entity";
import { OutboxMessageEntity } from "./src/wagering/infrastructure/persistence/entities/outboxMessage.entity";

export default defineConfig({
  entities: [
    WalletEntity,
    WalletLedgerEntryEntity,
    WagerTransactionEntity,
    InboxMessageEntity,
    OutboxMessageEntity,
  ],

  dbName: process.env.POSTGRES_DB ?? "jungle_gaming",
  user: process.env.POSTGRES_USER ?? "app_user",
  password: process.env.POSTGRES_PASSWORD,
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 5432),

  debug: process.env.NODE_ENV !== "production",

  extensions: [Migrator],
  migrations: {
    path: "./migrations",
    tableName: "mikro_orm_migrations",
    transactional: true,
    disableForeignKeys: false,
  },
});