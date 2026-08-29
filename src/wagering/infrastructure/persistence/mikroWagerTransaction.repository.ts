import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../../domain/wagerTransaction";
import { WagerTransactionRepository } from "../../ports/wagerTransaction.repository";
import { WagerTransactionEntity } from "./entities/wagerTransaction.entity";
import {
  wagerTransactionToDomain,
  wagerTransactionToEntityData,
  applyWagerTransactionToEntity,
} from "./wagerTransaction.mapper";

@Injectable()
export class MikroWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id });
    return entity ? wagerTransactionToDomain(entity) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey });
    return entity ? wagerTransactionToDomain(entity) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return entity ? wagerTransactionToDomain(entity) : null;
  }

  async findProcessedReversalByReference(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    const entity = await this.em.findOne(WagerTransactionEntity, {
      referenceTransaction: referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return entity ? wagerTransactionToDomain(entity) : null;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const entity = await this.em.findOne(WagerTransactionEntity, { id: transaction.id });
    if (entity) {
      applyWagerTransactionToEntity(transaction, entity);
    } else {
      this.em.create(WagerTransactionEntity, wagerTransactionToEntityData(transaction));
    }
    await this.em.flush();
  }

  async findDuePendingReferences(limit: number): Promise<WagerTransaction[]> {
    const now = new Date();
    const entities = await this.em.find(
      WagerTransactionEntity,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextReferenceRetryAt: null }, { nextReferenceRetryAt: { $lte: now } }],
      },
      { orderBy: { nextReferenceRetryAt: "asc", createdAt: "asc" }, limit },
    );
    return entities.map(wagerTransactionToDomain);
  }
}