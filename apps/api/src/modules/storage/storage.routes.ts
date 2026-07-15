import { Router } from "express";
import { fetchObjectStream, getStorageDiagnostics, hasObjectStorage, normalizeStorageKey } from "../../lib/storage.js";

const router = Router();

router.get("/*", async (req, res) => {
  try {
    const params = req.params as { "0"?: string };
    const rawKey = String(params["0"] || "");
    const resolvedRawKey = decodeSafe(rawKey);
    const key = normalizeStorageKey(resolvedRawKey);

    if (!key) {
      res.status(400).json({ message: "Chave do arquivo inválida." });
      return;
    }

    if (!hasObjectStorage()) {
      const diagnostics = getStorageDiagnostics();
      res.status(503).json({
        message: "Servico de armazenamento nao configurado.",
        detail: {
          missing: diagnostics.missing,
          bucket: diagnostics.bucket ? "definido" : "nao definido",
          region: diagnostics.region,
          endpoint: diagnostics.endpoint
        }
      });
      return;
    }

    const objectResponse = await fetchObjectStream(key);

    if (!objectResponse?.Body) {
      res.status(404).json({ message: "Arquivo nao encontrado." });
      return;
    }

    const body = objectResponse.Body;
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", objectResponse.ContentType || "application/octet-stream");
    if (objectResponse.ContentLength) {
      res.setHeader("Content-Length", String(objectResponse.ContentLength));
    }

    if (objectResponse.ETag) {
      res.setHeader("ETag", objectResponse.ETag);
    }

    if (objectResponse.LastModified) {
      res.setHeader("Last-Modified", objectResponse.LastModified.toUTCString());
    }

    if (typeof (body as NodeJS.ReadableStream).pipe === "function") {
      (body as NodeJS.ReadableStream).pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length > 0) {
      res.end(Buffer.concat(chunks));
    } else {
      res.status(404).json({ message: "Arquivo vazio." });
    }
  } catch (error) {
    if (error instanceof Error && isNotFoundStorageError(error)) {
      res.status(404).json({ message: "Arquivo nao encontrado." });
      return;
    }

    res.status(500).json({
      message: "Falha ao carregar arquivo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  }
});

function isNotFoundStorageError(error: Error & { name?: string; $metadata?: { httpStatusCode?: number } }) {
  if (error?.name === "NoSuchKey" || error?.name === "NotFound") {
    return true;
  }

  return error?.$metadata?.httpStatusCode === 404;
}

function decodeSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default router;
