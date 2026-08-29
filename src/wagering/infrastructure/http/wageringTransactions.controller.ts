import { BadRequestException, Body, ConflictException, Controller, Get, Headers, NotFoundException, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";

import {
  ProcessWagerTransactionUseCase,
  WalletNotFoundError,
  IdempotencyConflictError,
} from "../../application/processWagerTransaction.useCase";
import { WagerTransactionRepository } from "../../ports/wagerTransaction.repository";
import { WagerTransactionStatus, type WagerTransactionKind } from "../../domain/wagerTransaction";
import { SubmitWagerTransactionDto } from "./dto/submitWagerTransaction.dto";
import { presentWagerTransaction } from "./presenters/wagerTransaction.presenter";

/**
 * Mapeamento de status de negócio -> status HTTP (seção 9: a API precisa distinguir
 * com clareza, e de forma consistente, cada situação).
 * PROCESSED -> 200 (aplicada); REJECTED -> 422 (sintaticamente válida, rejeitada por
 * regra de negócio); PENDING_REFERENCE -> 202 (aceita, processamento pendente).
 */
function httpStatusForWagerStatus(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.PendingReference:
      return 202;
    default:
      return 200;
  }
}

@Controller("wagering/transactions")
export class WageringTransactionsController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
  ) {}

  @Get(":transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    const transaction = await this.wagerTransactionRepository.findById(transactionId);
    if (!transaction) {
      throw new NotFoundException(`transação ${transactionId} não encontrada`);
    }
    return presentWagerTransaction(transaction);
  }

  @Post()
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException("header Idempotency-Key é obrigatório");
    }

    try {
      const result = await this.processWagerTransaction.execute({
        idempotencyKey,
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind as WagerTransactionKind,
        money: dto.money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
      });

      res.status(httpStatusForWagerStatus(result.status));
      return result;
    } catch (err) {
      if (err instanceof WalletNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof IdempotencyConflictError) throw new ConflictException(err.message);
      throw err;
    }
  }
}