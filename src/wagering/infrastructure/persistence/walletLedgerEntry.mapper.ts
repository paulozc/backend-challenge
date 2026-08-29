import { WalletLedgerEntry, LedgerDirection } from "../../domain/walletLedgerEntry";
import { Money } from "../../domain/money";
import { WalletLedgerEntryEntity } from "./entities/walletLedgerEntry.entity";

/** DB (via MikroORM) -> domínio. Usa WalletLedgerEntry.rehydrate() — não revalida. */
export function walletLedgerEntryToDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: entity.id,
    walletId: entity.wallet, // mapToPk() -> já é o uuid puro (string), não um objeto Wallet carregado
    transactionId: entity.transactionId,
    direction: entity.direction,
    money: Money.from({ amount: entity.moneyAmount, currency: entity.currency }),
    balanceBefore: Money.from({ amount: entity.balanceBeforeAmount, currency: entity.currency }),
    balanceAfter: Money.from({ amount: entity.balanceAfterAmount, currency: entity.currency }),
    createdAt: entity.createdAt,
  });
}

/**
 * domínio -> dado pra criar uma linha nova. Diferente do wallet.mapper.ts (que tem
 * applyWalletToEntity pra atualizar uma entidade já rastreada): WalletLedgerEntry
 * nunca é atualizado, só criado — não existe "apply" aqui, só "toEntityData" pra
 * usar com em.create(WalletLedgerEntryEntity, ...) no repositório.
 */
export function walletLedgerEntryToEntityData(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    wallet: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    currency: entry.money.currency,
    moneyAmount: entry.money.toJSON().amount,
    balanceBeforeAmount: entry.balanceBefore.toJSON().amount,
    balanceAfterAmount: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  };
}