import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { WalletLedgerEntry } from "../../domain/walletLedgerEntry";
import { WalletLedgerEntryRepository } from "../../ports/walletLedgerEntry.repository";
import { WalletLedgerEntryEntity } from "./entities/walletLedgerEntry.entity";
import { walletLedgerEntryToEntityData } from "./walletLedgerEntry.mapper";

@Injectable()
export class MikroWalletLedgerEntryRepository extends WalletLedgerEntryRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async create(entry: WalletLedgerEntry): Promise<void> {
    this.em.create(WalletLedgerEntryEntity, walletLedgerEntryToEntityData(entry));
    await this.em.flush();
  }
}