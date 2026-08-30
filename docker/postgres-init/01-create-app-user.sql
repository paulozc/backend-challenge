-- Roda uma vez, na primeira inicialização do volume do Postgres (mecanismo padrão da
-- imagem oficial: qualquer .sql/.sh em /docker-entrypoint-initdb.d roda em ordem alfabética).
--
-- app_user é a role de runtime (privilégio mínimo) que a aplicação usa pra conectar.
-- As migrations rodam com a role "postgres" (dono do banco em dev) e terminam concedendo
-- os privilégios específicos pro app_user (ver final do up() na migration inicial) —
-- por isso a role precisa existir ANTES de qualquer migration rodar.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user WITH LOGIN PASSWORD 'app_user_dev_password';
  END IF;
END
$$;