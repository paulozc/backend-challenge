import { Module } from "@nestjs/common";
import { PersistenceModule } from "./infrastructure/persistence/persistence.module";

import { WalletRepository } from "./ports/wallet.repository";
import { WagerTransactionRepository } from "./ports/wagerTransaction.repository";
import { WalletLedgerEntryRepository } from "./ports/walletLedgerEntry.repository";
import { UnitOfWork } from "./ports/unitOfWork";
import { IdGenerator } from "./ports/idGenerator";

import { MikroWalletRepository } from "./infrastructure/persistence/mikroWallet.repository";
import { MikroWagerTransactionRepository } from "./infrastructure/persistence/mikroWagerTransaction.repository";
import { MikroWalletLedgerEntryRepository } from "./infrastructure/persistence/mikroWalletLedgerEntry.repository";
import { MikroUnitOfWork } from "./infrastructure/persistence/mikroUnitOfWork";
import { UuidV7IdGenerator } from "./infrastructure/uuidV7IdGenerator";

import { OpenWalletUseCase } from "./application/openWallet.useCase";

@Module({
  imports: [PersistenceModule],
  providers: [
    { provide: WalletRepository, useClass: MikroWalletRepository },
    { provide: WagerTransactionRepository, useClass: MikroWagerTransactionRepository },
    { provide: WalletLedgerEntryRepository, useClass: MikroWalletLedgerEntryRepository },
    { provide: UnitOfWork, useClass: MikroUnitOfWork },
    { provide: IdGenerator, useClass: UuidV7IdGenerator },
    OpenWalletUseCase,
  ],
  exports: [OpenWalletUseCase],
})
export class WageringModule {}