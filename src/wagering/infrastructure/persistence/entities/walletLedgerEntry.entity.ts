import { defineEntity, p } from "@mikro-orm/postgresql";
import { WalletEntity } from "./wallet.entity";
import { LedgerDirection } from "../../../domain/walletLedgerEntry";

export const WalletLedgerEntrySchema = defineEntity({
  name: "WalletLedgerEntry",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    wallet: () => p.manyToOne(WalletEntity).mapToPk(),
    transactionId: p.uuid(),
    direction: p.enum(() => LedgerDirection),
    currency: p.string().length(3),
    moneyAmount: p.decimal().precision(19).scale(2),
    balanceBeforeAmount: p.decimal().precision(19).scale(2),
    balanceAfterAmount: p.decimal().precision(19).scale(2),
    createdAt: p.datetime(),
  },
  indexes: [
    { name: "wle_wallet_cursor_idx", properties: ["wallet", "createdAt", "id"] },
  ],
  checks: [
    { name: "wle_money_positive_ck", expression: (c) => `${c.moneyAmount} > 0` },
    { name: "wle_balance_before_non_negative_ck", expression: (c) => `${c.balanceBeforeAmount} >= 0` },
    { name: "wle_balance_after_non_negative_ck", expression: (c) => `${c.balanceAfterAmount} >= 0` },
    {
      name: "wle_arithmetic_balanced_ck",
      expression: (c) =>
        `((${c.direction} = 'DEBIT' AND ${c.balanceAfterAmount} = ${c.balanceBeforeAmount} - ${c.moneyAmount}) OR ` +
        `(${c.direction} = 'CREDIT' AND ${c.balanceAfterAmount} = ${c.balanceBeforeAmount} + ${c.moneyAmount}))`,
    },
  ],
  // imutabilidade em duas camadas: isso cobre a camada 2 (trigger).
  // a camada 1 (REVOKE UPDATE/DELETE do app_user) continua fora da entidade,
  // é infraestrutura de role/grant, não schema de tabela.
  triggers: [
    {
      name: "wle_immutable",
      timing: "before",
      events: ["update", "delete"],
      body: `RAISE EXCEPTION 'wallet_ledger_entries é append-only: % não é permitido', TG_OP;`,
    },
  ],
});

export class WalletLedgerEntryEntity extends WalletLedgerEntrySchema.class {}
WalletLedgerEntrySchema.setClass(WalletLedgerEntryEntity);