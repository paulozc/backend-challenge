import { Injectable } from "@nestjs/common";
import { UniqueConstraintViolationException } from "@mikro-orm/core";

import { WalletRepository } from "../ports/wallet.repository";
import { WagerTransactionRepository } from "../ports/wagerTransaction.repository";
import { WalletLedgerEntryRepository } from "../ports/walletLedgerEntry.repository";
import { OutboxMessageRepository } from "../ports/outboxMessage.repository";
import { UnitOfWork } from "../ports/unitOfWork";
import { IdGenerator } from "../ports/idGenerator";

import { Money, type MoneyProps } from "../domain/money";
import { Wallet, InsufficientFundsError } from "../domain/wallet";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, type FailureCode } from "../domain/wagerTransaction";
import { LedgerDirection } from "../domain/walletLedgerEntry";
import { OutboxMessage } from "../domain/outboxMessage";
import type { IntegrationEvent } from "../domain/integrationEvent";
import type { EventContext } from "../domain/events/eventContext";
import { WagerTransactionProcessed } from "../domain/events/wagerTransactionProcessed";
import { WagerTransactionRejected } from "../domain/events/wagerTransactionRejected";
import { WagerTransactionPendingReference } from "../domain/events/wagerTransactionPendingReference";
import { WalletBalanceChanged } from "../domain/events/walletBalanceChanged";

import { computePayloadHash } from "./payloadHash";

export const WagerFailureCode = {
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  ReferenceMismatch: "REFERENCE_MISMATCH",
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  ReferenceKindNotAllowed: "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceAmountMismatch: "REFERENCE_AMOUNT_MISMATCH",
  ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
  // distinto de InsufficientFunds de propósito (seção 7): são situações operacionalmente diferentes
  ReversalWouldOverdraw: "REVERSAL_WOULD_OVERDRAW",
  // esgotou o limite de tentativas do worker de reprocessamento (seção 7.1) sem achar a referência
  ReferenceNeverArrived: "REFERENCE_NEVER_ARRIVED",
} as const satisfies Record<string, FailureCode>;

// seção 7.1: limite de tentativas antes de desistir e rejeitar. Combinado com o backoff
// de WagerTransaction (5s a 10min), dá uma janela de ~20min e ~8 tentativas antes de
// concluir que a referência genuinamente nunca vai chegar.
const MAX_REFERENCE_RETRY_ATTEMPTS = 8;

export class WalletNotFoundError extends Error {}
export class IdempotencyConflictError extends Error {}
export class UnsupportedKindError extends Error {}

export interface SubmitWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
    private readonly outboxMessageRepository: OutboxMessageRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly idGenerator: IdGenerator,
  ) {}

  /** correlationId = id da própria WagerTransaction — provisório até termos um id de
   * requisição/mensagem de entrada vindo da camada HTTP/SQS pra propagar aqui. */
  private newEventContext(at: Date, correlationId: string): EventContext {
    return { eventId: this.idGenerator.generate(), correlationId, occurredAt: at };
  }

  private async emitEvent(event: IntegrationEvent<unknown>): Promise<void> {
    await this.outboxMessageRepository.create(OutboxMessage.enqueue(event));
  }

  async execute(input: SubmitWagerTransactionInput): Promise<SubmitWagerTransactionOutput> {
    const money = Money.from(input.money);

    const payloadHash = computePayloadHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    const existing = await this.wagerTransactionRepository.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(
          `idempotency key "${input.idempotencyKey}" já foi usada com um payload diferente`,
        );
      }
      return this.buildReplayResponse(existing);
    }

    // BET, WIN, LOSS, REFUND, ROLLBACK — todos os kinds externos suportados (OPENING é interno, nunca vem daqui)
    const supportedKinds = [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ];
    if (!supportedKinds.includes(input.kind)) {
      throw new UnsupportedKindError(`kind ${input.kind} ainda não suportado por este use case`);
    }

    try {
      return await this.unitOfWork.transactional(() => this.dispatch(input, money, payloadHash));
    } catch (err) {
      // rede de segurança: duas requisições com a mesma idempotency key passando
      // pela checagem otimista ao mesmo tempo — a constraint UNIQUE resolve a corrida.
      if (err instanceof UniqueConstraintViolationException) {
        const winner = await this.wagerTransactionRepository.findByIdempotencyKey(input.idempotencyKey);
        if (winner) return this.buildReplayResponse(winner);
      }
      throw err;
    }
  }

  private dispatch(
    input: SubmitWagerTransactionInput,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionOutput> {
    switch (input.kind) {
      case WagerTransactionKind.Bet:
        return this.processBet(input, money, payloadHash);
      case WagerTransactionKind.Win:
        return this.processWin(input, money, payloadHash);
      case WagerTransactionKind.Loss:
        return this.processLoss(input, money, payloadHash);
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Rollback:
        return this.processReversal(input, money, payloadHash, input.kind);
      default:
        throw new UnsupportedKindError(`kind ${input.kind} ainda não suportado por este use case`);
    }
  }

  private async processBet(
    input: SubmitWagerTransactionInput,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionOutput> {
    const wallet = await this.walletRepository.findByIdForUpdate(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet ${input.walletId} não encontrada`);
    }

    const at = new Date();
    const transaction = WagerTransaction.create({
      id: this.idGenerator.generate(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: WagerTransactionKind.Bet,
      money,
      createdAt: at,
    });

    try {
      const entry = wallet.debit({
        entryId: this.idGenerator.generate(),
        transactionId: transaction.id,
        money,
        at,
      });
      transaction.markProcessed(undefined, at);

      await this.walletRepository.save(wallet);
      await this.wagerTransactionRepository.save(transaction);
      await this.walletLedgerEntryRepository.create(entry);
      await this.emitEvent(WagerTransactionProcessed.from(transaction, this.newEventContext(at, transaction.id)));
      await this.emitEvent(WalletBalanceChanged.from(wallet, entry, this.newEventContext(at, transaction.id)));

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        return this.rejectAndSave(transaction, WagerFailureCode.InsufficientFunds, wallet, at);
      }
      throw err;
    }
  }

  private async processWin(
    input: SubmitWagerTransactionInput,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionOutput> {
    const wallet = await this.walletRepository.findByIdForUpdate(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet ${input.walletId} não encontrada`);
    }

    const at = new Date();
    const transaction = WagerTransaction.create({
      id: this.idGenerator.generate(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: WagerTransactionKind.Win,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: at,
    });

    // referência é opcional pro WIN — quando informada, valida pertencimento se encontrada,
    // mas não bloqueia o crédito se a referência ainda não tiver chegado (diferente de
    // REFUND/ROLLBACK, cujo efeito depende da referência). Interpretação documentada no
    // ARCHITECTURE.md, seção 7 não deixa isso 100% explícito pro WIN especificamente.
    let referenceTransactionId: string | undefined;
    if (input.referenceExternalTransactionId) {
      const reference = await this.wagerTransactionRepository.findByProviderAndExternalId(
        input.providerId,
        input.referenceExternalTransactionId,
      );
      if (reference) {
        const belongsToSameContext =
          reference.playerId === input.playerId &&
          reference.walletId === input.walletId &&
          reference.money.currency === money.currency &&
          reference.roundId === input.roundId;

        if (!belongsToSameContext) {
          return this.rejectAndSave(transaction, WagerFailureCode.ReferenceMismatch, wallet, at);
        }
        referenceTransactionId = reference.id;
      }
      // se não encontrada: segue sem linkar (best-effort) — não bloqueia o crédito
    }

    const entry = wallet.credit({
      entryId: this.idGenerator.generate(),
      transactionId: transaction.id,
      money,
      at,
    });
    transaction.markProcessed(referenceTransactionId, at);

    await this.walletRepository.save(wallet);
    await this.wagerTransactionRepository.save(transaction);
    await this.walletLedgerEntryRepository.create(entry);
    await this.emitEvent(WagerTransactionProcessed.from(transaction, this.newEventContext(at, transaction.id)));
    await this.emitEvent(WalletBalanceChanged.from(wallet, entry, this.newEventContext(at, transaction.id)));

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async processLoss(
    input: SubmitWagerTransactionInput,
    money: Money,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionOutput> {
    // LOSS não muda saldo — não precisa de lock pessimista, só confirma que a wallet existe
    const wallet = await this.walletRepository.findById(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet ${input.walletId} não encontrada`);
    }

    const at = new Date();
    const transaction = WagerTransaction.create({
      id: this.idGenerator.generate(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: WagerTransactionKind.Loss,
      money,
      createdAt: at,
    });
    transaction.markProcessed(undefined, at);

    // sem wallet.save(), sem ledger entry — LOSS não afeta saldo (affectsBalance() === false)
    await this.wagerTransactionRepository.save(transaction);
    await this.emitEvent(WagerTransactionProcessed.from(transaction, this.newEventContext(at, transaction.id)));

    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async rejectAndSave(
    transaction: WagerTransaction,
    code: FailureCode,
    wallet: Wallet,
    at: Date,
  ): Promise<SubmitWagerTransactionOutput> {
    transaction.reject(code);
    await this.wagerTransactionRepository.save(transaction);
    await this.emitEvent(WagerTransactionRejected.from(transaction, this.newEventContext(at, transaction.id)));
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
    };
  }

  private async processReversal(
    input: SubmitWagerTransactionInput,
    money: Money,
    payloadHash: string,
    kind: typeof WagerTransactionKind.Refund | typeof WagerTransactionKind.Rollback,
  ): Promise<SubmitWagerTransactionOutput> {
    // referenceExternalTransactionId presente é garantido por WagerTransaction.create() (referencePolicyFor)
    const wallet = await this.walletRepository.findByIdForUpdate(input.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`wallet ${input.walletId} não encontrada`);
    }

    const at = new Date();
    const transaction = WagerTransaction.create({
      id: this.idGenerator.generate(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: at,
    });

    const reference = await this.wagerTransactionRepository.findByProviderAndExternalId(
      input.providerId,
      input.referenceExternalTransactionId!,
    );

    // referência ainda não chegou (entrega fora de ordem) — não é erro, fica pendente pro
    // worker de reprocessamento (seção 7.1) tentar de novo depois.
    if (!reference) {
      transaction.markPendingReference();
      await this.wagerTransactionRepository.save(transaction);
      await this.emitEvent(WagerTransactionPendingReference.from(transaction, this.newEventContext(at, transaction.id)));
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    return this.applyReversalWithReference(transaction, wallet, reference, money, kind, at);
  }

  /**
   * Núcleo de validação + aplicação de REFUND/ROLLBACK, assumindo que a referência JÁ foi
   * encontrada. Compartilhado entre o processamento inicial (processReversal, acima) e o
   * worker de reprocessamento de PENDING_REFERENCE (retryPendingReference, abaixo) — a
   * mesma cadeia de regras vale não importa QUANDO a referência é finalmente resolvida.
   */
  private async applyReversalWithReference(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction,
    money: Money,
    kind: typeof WagerTransactionKind.Refund | typeof WagerTransactionKind.Rollback,
    at: Date,
  ): Promise<SubmitWagerTransactionOutput> {
    if (reference.status !== WagerTransactionStatus.Processed) {
      return this.rejectAndSave(transaction, WagerFailureCode.ReferenceNotProcessed, wallet, at);
    }

    const belongsToSameContext =
      reference.playerId === transaction.playerId &&
      reference.walletId === transaction.walletId &&
      reference.money.currency === money.currency &&
      reference.roundId === transaction.roundId;
    if (!belongsToSameContext) {
      return this.rejectAndSave(transaction, WagerFailureCode.ReferenceMismatch, wallet, at);
    }

    // REFUND só referencia BET. ROLLBACK referencia BET, WIN ou REFUND (seção 7).
    const allowedReferenceKinds =
      kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    if (!allowedReferenceKinds.includes(reference.kind)) {
      return this.rejectAndSave(transaction, WagerFailureCode.ReferenceKindNotAllowed, wallet, at);
    }

    // reversão parcial está fora de escopo — valor precisa ser exatamente igual ao da referência
    if (!money.equals(reference.money)) {
      return this.rejectAndSave(transaction, WagerFailureCode.ReferenceAmountMismatch, wallet, at);
    }

    // checagem proativa, segura porque o lock pessimista da wallet acima já serializa
    // qualquer tentativa concorrente de reverter a MESMA referência (ela pertence à mesma wallet).
    // o índice único parcial do banco continua como rede de segurança, não o mecanismo principal.
    const alreadyReversed = await this.wagerTransactionRepository.findProcessedReversalByReference(reference.id, kind);
    if (alreadyReversed) {
      return this.rejectAndSave(transaction, WagerFailureCode.ReferenceAlreadyReversed, wallet, at);
    }

    const direction = transaction.ledgerDirectionFor(reference);
    const movementProps = { entryId: this.idGenerator.generate(), transactionId: transaction.id, money, at };

    try {
      const entry =
        direction === LedgerDirection.Credit ? wallet.credit(movementProps) : wallet.debit(movementProps);

      transaction.markProcessed(reference.id, at);
      await this.walletRepository.save(wallet);
      await this.wagerTransactionRepository.save(transaction);
      await this.walletLedgerEntryRepository.create(entry);
      await this.emitEvent(WagerTransactionProcessed.from(transaction, this.newEventContext(at, transaction.id)));
      await this.emitEvent(WalletBalanceChanged.from(wallet, entry, this.newEventContext(at, transaction.id)));

      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        // distinto de InsufficientFunds de uma BET — "reversão causaria saldo negativo" é
        // operacionalmente diferente de "aposta sem saldo" (seção 7), mesmo sendo o mesmo
        // tipo de erro de domínio por baixo.
        return this.rejectAndSave(transaction, WagerFailureCode.ReversalWouldOverdraw, wallet, at);
      }
      throw err;
    }
  }

  /**
   * Chamado pelo worker de reprocessamento de PENDING_REFERENCE (seção 7.1). Tenta resolver
   * a referência de novo; se ainda não achou, reagenda com backoff ou desiste (REJECTED)
   * se esgotou o limite de tentativas.
   */
  async retryPendingReference(transactionId: string): Promise<void> {
    await this.unitOfWork.transactional(async () => {
      const transaction = await this.wagerTransactionRepository.findById(transactionId);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        return; // já não está mais pendente — outro worker pode ter resolvido primeiro
      }

      const wallet = await this.walletRepository.findByIdForUpdate(transaction.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`wallet ${transaction.walletId} não encontrada ao reprocessar ${transactionId}`);
      }

      const reference = await this.wagerTransactionRepository.findByProviderAndExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId!,
      );

      const at = new Date();

      if (!reference) {
        if (!transaction.hasReferenceRetriesLeft(MAX_REFERENCE_RETRY_ATTEMPTS)) {
          transaction.reject(WagerFailureCode.ReferenceNeverArrived);
          await this.wagerTransactionRepository.save(transaction);
          await this.emitEvent(WagerTransactionRejected.from(transaction, this.newEventContext(at, transaction.id)));
        } else {
          transaction.scheduleReferenceRetry(at);
          await this.wagerTransactionRepository.save(transaction);
        }
        return;
      }

      await this.applyReversalWithReference(
        transaction,
        wallet,
        reference,
        transaction.money,
        transaction.kind as typeof WagerTransactionKind.Refund | typeof WagerTransactionKind.Rollback,
        at,
      );
    });
  }

  private async buildReplayResponse(existing: WagerTransaction): Promise<SubmitWagerTransactionOutput> {
    let balance: MoneyProps;

    if (existing.status === WagerTransactionStatus.Processed && existing.affectsBalance()) {
      // saldo observado no momento original — não o saldo atual da wallet, que pode já ter mudado
      const entry = await this.walletLedgerEntryRepository.findByTransactionId(existing.id);
      if (!entry) {
        throw new Error(`inconsistência: transação ${existing.id} afeta saldo e está PROCESSED mas não tem lançamento no ledger`);
      }
      balance = entry.balanceAfter.toJSON();
    } else {
      // LOSS (ou qualquer kind que não afeta saldo) não tem lançamento — usa o saldo atual da wallet
      const wallet = await this.walletRepository.findById(existing.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`wallet ${existing.walletId} não encontrada`);
      }
      balance = wallet.balance.toJSON();
    }

    return {
      transactionId: existing.id,
      status: existing.status,
      balance,
      idempotentReplay: true,
    };
  }
}