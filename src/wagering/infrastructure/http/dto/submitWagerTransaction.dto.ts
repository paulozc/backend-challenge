import { IsIn, IsOptional, IsString, IsUUID, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { MoneyDto } from "./money.dto";

// OPENING de propósito fora dessa lista — é interno (seção 6.3), nunca aceito via API/fila
const ALLOWED_KINDS = ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"] as const;
export type AllowedWagerTransactionKind = (typeof ALLOWED_KINDS)[number];

export class SubmitWagerTransactionDto {
  @IsString()
  providerId!: string;

  @IsString()
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  roundId!: string;

  @IsString()
  gameId!: string;

  @IsIn(ALLOWED_KINDS, { message: `kind deve ser um de: ${ALLOWED_KINDS.join(", ")}` })
  kind!: AllowedWagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}