import { Global, Module } from "@nestjs/common";
import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
import { MikroORM, EntityManager, RequestContext } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../../../mikro-orm.config";

/**
 * Substitui @mikro-orm/nestjs, que hoje (7.0.2) exige @nestjs/core ^11.0.5 —
 * incompatível com o NestJS 12 que este projeto usa (confirmado: ERESOLVE ao instalar).
 * Isso replica só a parte que realmente precisamos do pacote oficial: inicializar
 * o MikroORM uma vez e aplicar o middleware de RequestContext, que isola a
 * EntityManager por requisição (validado: duas requisições concorrentes não
 * corrompem o identity map uma da outra).
 */
@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: async () => MikroORM.init(mikroOrmConfig),
    },
    {
      provide: EntityManager,
      useFactory: (orm: MikroORM) => orm.em,
      inject: [MikroORM],
    },
  ],
  exports: [MikroORM, EntityManager],
})
export class PersistenceModule implements NestModule {
  constructor(private readonly orm: MikroORM) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_req: unknown, _res: unknown, next: () => void) => {
        RequestContext.create(this.orm.em, next);
      })
      .forRoutes("*");
  }
}