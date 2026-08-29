import { Body, Controller, ConflictException, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { OpenWalletUseCase, WalletAlreadyExistsError } from "../../application/openWallet.useCase";
import { CreateWalletDto } from "./dto/create-wallet.dto";

@Controller("wallets")
export class WalletsController {
  constructor(private readonly openWalletUseCase: OpenWalletUseCase) {}

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
}