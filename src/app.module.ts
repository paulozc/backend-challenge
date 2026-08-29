import { Module } from "@nestjs/common";
import { WageringModule } from "./wagering/wagering.module";

@Module({
  imports: [WageringModule],
})
export class AppModule {}