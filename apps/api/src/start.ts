await import("./server.js");
const { runBootstrap } = await import("./bootstrap.js");

// Start listening first so Railway health checks do not time out while maintenance runs.
void runBootstrap().catch((error) => {
  console.error("Falha nas rotinas de inicializacao da API:", error);
});
