import { defineEntity, p } from "@mikro-orm/postgresql";

export const WalletSchema = defineEntity({
  name: "Wallet",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string().length(3),
    balanceAmount: p.decimal().precision(19).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
  uniques: [{ name: "wallets_player_currency_uq", properties: ["playerId", "currency"] }],
  checks: [
    { name: "wallets_balance_non_negative_ck", expression: (c) => `${c.balanceAmount} >= 0` },
    { name: "wallets_currency_format_ck", expression: (c) => `${c.currency} ~ '^[A-Z]{3}$'` },
    { name: "wallets_version_positive_ck", expression: (c) => `${c.version} >= 1` },
  ],
});

export class WalletEntity extends WalletSchema.class {}
WalletSchema.setClass(WalletEntity);