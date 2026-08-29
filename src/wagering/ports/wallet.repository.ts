// src/wagering/ports/wallet.repository.ts
import { Wallet } from "../domain/wallet";

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | null>;
  abstract findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  abstract save(wallet: Wallet): Promise<void>;

  /** carrega com lock pessimista — usado quando o use case vai modificar o saldo */
  abstract findByIdForUpdate(id: string): Promise<Wallet | null>;
}