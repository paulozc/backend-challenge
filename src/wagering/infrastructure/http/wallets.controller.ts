import { Body, Controller, ConflictException, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { OpenWalletUseCase, WalletAlreadyExistsError } from "../../application/openWallet.useCase";
import { WalletRepository } from "../../ports/wallet.repository";
import { WalletLedgerEntryRepository } from "../../ports/walletLedgerEntry.repository";
import { CreateWalletDto } from "./dto/create-wallet.dto";
import { encodeCursor, decodeCursor } from "./cursor";

@Controller("wallets")
export class WalletsController {
  constructor(
    private readonly openWalletUseCase: OpenWalletUseCase,
    private readonly walletRepository: WalletRepository,
    private readonly walletLedgerEntryRepository: WalletLedgerEntryRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateWalletDto) {
    try {
      return await this.openWalletUseCase.execute(dto);
    } catch (err) {
      if (err instanceof WalletAlreadyExistsError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  @Get(":walletId")
  async getById(@Param("walletId") walletId: string) {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`wallet ${walletId} não encontrada`);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(":walletId/ledger")
  async getLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursorParam?: string,
    @Query("limit") limitParam?: string,
  ) {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`wallet ${walletId} não encontrada`);
    }

    const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200);
    const cursor = cursorParam ? decodeCursor(cursorParam) : null;

    const entries = await this.walletLedgerEntryRepository.findByWallet(walletId, cursor, limit);
    const last = entries[entries.length - 1];
    const nextCursor = entries.length === limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

    return {
      entries: entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }
}