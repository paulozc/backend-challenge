import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { WagerTransactionRepository } from "../../ports/wagerTransaction.repository";
import { presentWagerTransaction } from "./presenters/wagerTransaction.presenter";

@Controller("providers/:providerId/wagering/transactions")
export class ProviderWagerTransactionsController {
  constructor(private readonly wagerTransactionRepository: WagerTransactionRepository) {}

  @Get(":externalTransactionId")
  async getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const transaction = await this.wagerTransactionRepository.findByProviderAndExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new NotFoundException(
        `transação não encontrada pra providerId=${providerId} externalTransactionId=${externalTransactionId}`,
      );
    }
    return presentWagerTransaction(transaction);
  }
}