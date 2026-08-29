import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { Wallet } from "../../domain/wallet";
import { WalletRepository } from "../../ports/wallet.repository";
import { WalletEntity } from "./entities/wallet.entity";
import { walletToDomain, applyWalletToEntity } from "./wallet.mapper";

@Injectable()
export class MikroWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id });
    return entity ? walletToDomain(entity) : null;
  }

  /** Carrega com SELECT ... FOR UPDATE — usar quando o use case vai modificar o saldo. */
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return entity ? walletToDomain(entity) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.em.findOne(WalletEntity, { playerId, currency });
    return entity ? walletToDomain(entity) : null;
  }

  /** Cria se ainda não existe (identity map do MikroORM garante que reaproveita a mesma instância se já foi carregada nesta transação), atualiza se já existe. */
  async save(wallet: Wallet): Promise<void> {
    let entity = await this.em.findOne(WalletEntity, { id: wallet.id });
    if (entity) {
      applyWalletToEntity(wallet, entity);
    } else {
      entity = this.em.create(WalletEntity, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceAmount: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      });
    }
    await this.em.flush();
  }
}