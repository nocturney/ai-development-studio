import { scanOllama } from "./ollama.mjs";
import { PROVIDER_CATALOG } from "./providers.mjs";

const command = process.argv[2] ?? "help";
if (command === "scan") {
  const instances = await scanOllama();
  console.log(JSON.stringify({
    mode: "local-only",
    online: instances.length,
    instances
  }, null, 2));
} else if (command === "providers") {
  console.log(JSON.stringify(PROVIDER_CATALOG, null, 2));
} else {
  console.log("Usage: node src/cli.mjs [scan|providers]");
  process.exitCode = command === "help" ? 0 : 2;
}
