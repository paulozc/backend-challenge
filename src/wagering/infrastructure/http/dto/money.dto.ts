import { IsString, Matches } from "class-validator";

export class MoneyDto {
  @IsString()
  @Matches(/^\d+\.\d{2}$/, { message: "amount deve ser uma string decimal com exatamente 2 casas (ex: 25.00)" })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: "currency deve ser um código ISO-4217 de 3 letras maiúsculas" })
  currency!: string;
}