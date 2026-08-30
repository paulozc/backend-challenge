import { Module } from "@nestjs/common";
import { WageringModule } from "./wagering/wagering.module";
import { HealthModule } from "./health/health.module";

@Module({
  imports: [WageringModule, HealthModule],
})
export class AppModule {}