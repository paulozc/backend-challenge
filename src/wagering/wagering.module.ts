import { Module } from "@nestjs/common";
import { PersistenceModule } from "./infrastructure/persistence/persistence.module";

import { WalletRepository } from "./ports/wallet.repository";
import { WagerTransactionRepository } from "./ports/wagerTransaction.repository";
import { WalletLedgerEntryRepository } from "./ports/walletLedgerEntry.repository";
import { OutboxMessageRepository } from "./ports/outboxMessage.repository";
import { UnitOfWork } from "./ports/unitOfWork";
import { IdGenerator } from "./ports/idGenerator";

import { MikroWalletRepository } from "./infrastructure/persistence/mikroWallet.repository";
import { MikroWagerTransactionRepository } from "./infrastructure/persistence/mikroWagerTransaction.repository";
import { MikroWalletLedgerEntryRepository } from "./infrastructure/persistence/mikroWalletLedgerEntry.repository";
import { MikroOutboxMessageRepository } from "./infrastructure/persistence/mikroOutboxMessage.repository";
import { MikroUnitOfWork } from "./infrastructure/persistence/mikroUnitOfWork";
import { UuidV7IdGenerator } from "./infrastructure/uuidV7IdGenerator";

import { OpenWalletUseCase } from "./application/openWallet.useCase";
import { ProcessWagerTransactionUseCase } from "./application/processWagerTransaction.useCase";
import { WalletsController } from "./infrastructure/http/wallets.controller";
import { WageringTransactionsController } from "./infrastructure/http/wagering-transactions.controller";

@Module({
  imports: [PersistenceModule],
  controllers: [WalletsController, WageringTransactionsController],
  providers: [
    { provide: WalletRepository, useClass: MikroWalletRepository },
    { provide: WagerTransactionRepository, useClass: MikroWagerTransactionRepository },
    { provide: WalletLedgerEntryRepository, useClass: MikroWalletLedgerEntryRepository },
    { provide: OutboxMessageRepository, useClass: MikroOutboxMessageRepository },
    { provide: UnitOfWork, useClass: MikroUnitOfWork },
    { provide: IdGenerator, useClass: UuidV7IdGenerator },
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
  ],
  exports: [OpenWalletUseCase, ProcessWagerTransactionUseCase],
})
export class WageringModule {}