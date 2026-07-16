import { createApp } from "./app.js";
import { reconcilePendingUploadsFromRegistry } from "./modules/uploads/uploads.routes.js";

const port = Number(process.env.PORT || 3000);
const app = createApp();
const PENDING_UPLOAD_RECONCILIATION_INTERVAL_MS = 60_000;

let reconciliationRunning = false;

async function runPendingUploadReconciliation() {
  if (reconciliationRunning) {
    return;
  }

  reconciliationRunning = true;

  try {
    await reconcilePendingUploadsFromRegistry();
  } catch (error) {
    console.error("Falha ao reconciliar espelhos pendentes com o pre-cadastro:", error);
  } finally {
    reconciliationRunning = false;
  }
}

app.listen(port, () => {
  console.log(`Portal Administrativo API online na porta ${port}`);
  void runPendingUploadReconciliation();

  const reconciliationTimer = setInterval(
    () => void runPendingUploadReconciliation(),
    PENDING_UPLOAD_RECONCILIATION_INTERVAL_MS
  );
  reconciliationTimer.unref();
});
