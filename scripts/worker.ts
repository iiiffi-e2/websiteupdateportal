import { processDue } from "../src/server/engine";
import { getEngine } from "../src/server/runtime";

async function main(): Promise<void> {
  const engine = await getEngine();
  for (;;) {
    await processDue(engine);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Worker failed.";
  console.error(message);
  process.exit(1);
});
