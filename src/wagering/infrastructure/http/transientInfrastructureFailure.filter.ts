import { Catch } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { ConnectionException, DeadlockException, DriverException, LockWaitTimeoutException } from "@mikro-orm/postgresql";

/**
 * Distingue falha transitória de infraestrutura (vale a pena tentar de novo) de qualquer
 * outro erro do driver do banco (violação de constraint, sintaxe SQL errada, tabela
 * inexistente — tudo isso é o servidor tendo processado a query e respondido algo
 * definitivo, não uma falha de infraestrutura).
 *
 * `exception?.constructor === DriverException` (comparação de classe exata, não
 * `instanceof`) é necessário porque uma falha de conexão "crua" (ex: ECONNREFUSED, antes
 * de qualquer handshake do protocolo Postgres) chega como a classe base `DriverException`
 * pura — não como `ConnectionException`, que é mais específica. Confirmado em teste real
 * contra uma porta que ninguém escuta. `instanceof DriverException` sozinho pegaria
 * TAMBÉM `UniqueConstraintViolationException`, `TableNotFoundException` etc. (todas são
 * subclasses), o que seria errado.
 */
export function isTransientInfrastructureFailure(exception: unknown): boolean {
  return (
    exception instanceof ConnectionException ||
    exception instanceof DeadlockException ||
    exception instanceof LockWaitTimeoutException ||
    exception?.constructor === DriverException
  );
}

@Catch()
export class TransientInfrastructureFailureFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (isTransientInfrastructureFailure(exception)) {
      const response = host.switchToHttp().getResponse();
      response.status(503).json({
        statusCode: 503,
        error: "ServiceUnavailable",
        message: "Falha temporária de infraestrutura — tente novamente em instantes.",
      });
      return;
    }
    // qualquer outro caso (HttpException já mapeada — 400/404/409/422 — ou erro
    // realmente inesperado) segue o comportamento padrão do Nest, sem interferência
    super.catch(exception, host);
  }
}