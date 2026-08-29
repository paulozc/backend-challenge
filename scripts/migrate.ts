import { MikroORM } from "@mikro-orm/postgresql";
import config from "../mikro-orm.config";


async function main() {
  const command = process.argv[2];
  if (command !== "up" && command !== "down" && command !== "create") {
    console.error("Uso: bun run scripts/migrate.ts up|down|create");
    process.exit(1);
  }

  const orm = await MikroORM.init(config);

  if (command === "up") {
    await orm.migrator.up();
    console.log("Migrado até a versão mais recente.");
  } else if (command === "down") {
    await orm.migrator.down();
    console.log("Revertido para a versão anterior.");
  } else {
    const result = await orm.migrator.create();
    console.log("Migration criada:", result.fileName);
  }

  await orm.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});