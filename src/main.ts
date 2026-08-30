import "reflect-metadata";
import { NestFactory, HttpAdapterHost } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { TransientInfrastructureFailureFilter } from "./wagering/infrastructure/http/transientInfrastructureFailure.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new TransientInfrastructureFailureFilter(httpAdapter));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`jungle-gaming rodando na porta ${port}`);
}

bootstrap();