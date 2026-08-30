import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

@Controller("health")
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  /**
   * Liveness: só confirma que o processo está respondendo, sem checar dependências
   * externas. Não queremos que um orquestrador reinicie a aplicação só porque o
   * Postgres ficou temporariamente indisponível — isso é assunto do readiness.
   */
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /**
   * Readiness: confirma que as dependências necessárias pra atender requisições estão
   * de pé. Um orquestrador usa isso pra decidir se deve rotear tráfego pra essa instância.
   */
  @Get("ready")
  async ready() {
    try {
      await this.em.getConnection().execute("select 1");
      return { status: "ok", checks: { database: "ok" } };
    } catch {
      throw new ServiceUnavailableException({ status: "error", checks: { database: "error" } });
    }
  }
}