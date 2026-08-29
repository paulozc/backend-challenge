import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { UnitOfWork } from "../../ports/unitOfWork";

@Injectable()
export class MikroUnitOfWork extends UnitOfWork {
  constructor(private readonly em: EntityManager) {
    super();
  }

  /**
   * em.transactional() propaga a transação via RequestContext (armazenamento
   * assíncrono ambiente do MikroORM) — qualquer repositório que injete a
   * EntityManager "raiz" do container (não uma fork manual) automaticamente
   * participa da mesma transação enquanto executar dentro de `work`.
   * Validado: dois repositórios injetados separadamente, sem receber a
   * EntityManager transacional explicitamente, commitam e revertem juntos.
   */
  transactional<T>(work: () => Promise<T>): Promise<T> {
    return this.em.transactional(() => work());
  }
}