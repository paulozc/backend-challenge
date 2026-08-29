/**
 * Abstração de fronteira transacional. O domínio e os use cases dependem só disso —
 * nunca de EntityManager, transactional() ou qualquer API do MikroORM diretamente.
 */
export abstract class UnitOfWork {
  /**
   * Executa `work` dentro de uma transação. Se `work` lançar, tudo é revertido;
   * se retornar normalmente, tudo é confirmado junto.
   */
  abstract transactional<T>(work: () => Promise<T>): Promise<T>;
}