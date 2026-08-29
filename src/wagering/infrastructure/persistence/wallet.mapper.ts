import { Wallet } from "../../domain/wallet";
import { Money } from "../../domain/money";
import { WalletEntity } from "./entities/wallet.entity";

/** DB (via MikroORM) -> domínio. Usa Wallet.rehydrate() — não revalida transições. */
export function walletToDomain(entity: WalletEntity): Wallet {
  return Wallet.rehydrate({
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: Money.from({ amount: entity.balanceAmount, currency: entity.currency }),
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  });
}

/** domínio -> DB: aplica o estado do agregado numa entidade já rastreada pelo EntityManager. */
export function applyWalletToEntity(wallet: Wallet, entity: WalletEntity): void {
  entity.balanceAmount = wallet.balance.toJSON().amount;
  entity.version = wallet.version;
  entity.updatedAt = wallet.updatedAt;
}