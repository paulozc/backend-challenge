import { Injectable } from "@nestjs/common";
import { UniqueConstraintViolationException } from "@mikro-orm/core";

import { WalletRepository } from "../ports/wallet.repository";
import { WagerTransactionRepository } from "../ports/wagerTransaction.repository";
import { WalletLedgerEntryRepository } from "../ports/walletLedgerEntry.repository";
import { OutboxMessageRepository } from "../ports/outboxMessage.repository";
import { UnitOfWork } from "../ports/unitOfWork";
import { IdGenerator } from "../ports/idGenerator";

import { Wallet } from "../domain/wallet";
import { Money, type MoneyProps } from "../domain/money";
import { WagerTransaction, WagerTransactionKind } from "../domain/wagerTransaction";
import { WalletLedgerEntry, LedgerDirection } from "../domain/walletLedgerEntry";
import { OutboxMessage } from "../domain/outboxMessage";
import { WagerTransactionProcessed } from "../domain/events/wagerTransactionProcessed";
import { WalletBalanceChanged } from "../domain/events/walletBalanceChanged";

export class WalletAlreadyExistsError extends Error {}

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class OpenWalletUseCase {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
    private readonly outboxMessageRepository: OutboxMessageRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    const initialBalance = Money.from(input.initialBalance);

    // checagem otimista — rápida, evita bater no banco no caso comum.
    // a garantia de verdade continua sendo a constraint UNIQUE(player_id, currency).
    const existing = await this.walletRepository.findByPlayerAndCurrency(input.playerId, initialBalance.currency);
    if (existing) {
      throw new WalletAlreadyExistsError(
        `já existe uma wallet para playerId=${input.playerId} currency=${initialBalance.currency}`,
      );
    }

    const wallet = Wallet.open({
      id: this.idGenerator.generate(),
      playerId: input.playerId,
      initialBalance,
    });

    try {
      await this.unitOfWork.transactional(async () => {
        await this.walletRepository.save(wallet);

        // só gera OPENING + lançamento (+ eventos) se o saldo inicial for maior que zero (seção 9)
        if (initialBalance.isPositive()) {
          const at = wallet.updatedAt;

          const openingTransaction = WagerTransaction.create({
            id: this.idGenerator.generate(),
            providerId: "internal",
            externalTransactionId: `opening-${wallet.id}`,
            idempotencyKey: `internal:opening-${wallet.id}`,
            payloadHash: "n/a",
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: "n/a",
            gameId: "n/a",
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: at,
          });
          openingTransaction.markProcessed(undefined, at);

          // criado direto (não via wallet.credit()) porque Wallet.open() já define o saldo
          // final na criação — não é um "movimento" sobre um saldo anterior existente.
          const openingEntry = WalletLedgerEntry.create({
            id: this.idGenerator.generate(),
            walletId: wallet.id,
            transactionId: openingTransaction.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance,
            createdAt: at,
          });

          await this.wagerTransactionRepository.save(openingTransaction);
          await this.walletLedgerEntryRepository.create(openingEntry);

          // correlationId = id da própria transação OPENING, mesmo critério do ProcessWagerTransactionUseCase
          await this.outboxMessageRepository.create(
            OutboxMessage.enqueue(
              WagerTransactionProcessed.from(openingTransaction, {
                eventId: this.idGenerator.generate(),
                correlationId: openingTransaction.id,
                occurredAt: at,
              }),
            ),
          );
          await this.outboxMessageRepository.create(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.idGenerator.generate(),
                correlationId: openingTransaction.id,
                occurredAt: at,
              }),
            ),
          );
        }
      });
    } catch (err) {
      // rede de segurança contra corrida entre a checagem otimista e o INSERT real
      if (err instanceof UniqueConstraintViolationException) {
        throw new WalletAlreadyExistsError(
          `já existe uma wallet para playerId=${input.playerId} currency=${initialBalance.currency}`,
        );
      }
      throw err;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}