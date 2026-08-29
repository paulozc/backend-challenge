import { Injectable } from "@nestjs/common";
import { WagerTransactionRepository } from "../../ports/wagerTransaction.repository";
import { ProcessWagerTransactionUseCase } from "../../application/processWagerTransaction.useCase";

@Injectable()
export class PendingReferenceRetryWorker {
  constructor(
    private readonly wagerTransactionRepository: WagerTransactionRepository,
    private readonly processWagerTransaction: ProcessWagerTransactionUseCase,
  ) {}

  /**
   * Processa um lote de PENDING_REFERENCE prontas pra tentar de novo. Retorna quantas
   * foram processadas (0 = nada pendente/pronto no momento).
   */
  async pollOnce(batchSize = 10): Promise<number> {
    const due = await this.wagerTransactionRepository.findDuePendingReferences(batchSize);
    for (const transaction of due) {
      await this.processWagerTransaction.retryPendingReference(transaction.id);
    }
    return due.length;
  }
}