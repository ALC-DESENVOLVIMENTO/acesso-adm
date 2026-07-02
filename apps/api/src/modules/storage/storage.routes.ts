import { Router } from "express";
import { fetchObjectStream, hasObjectStorage, normalizeStorageKey } from "../../lib/storage.js";

const router = Router();

router.get("/*", async (req, res) => {
  try {
    const params = req.params as { "0"?: string };
    const rawKey = String(params["0"] || "");
    const key = normalizeStorageKey(rawKey);

    if (!key) {
      res.status(400).json({ message: "Chave do arquivo invalida." });
      return;
    }

    if (!hasObjectStorage()) {
      res.status(503).json({ message: "Servico de armazenamento nao configurado." });
      return;
    }

    const objectResponse = await fetchObjectStream(key);

    if (!objectResponse?.Body) {
      res.status(404).json({ message: "Arquivo nao encontrado." });
      return;
    }

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

    (objectResponse.Body as NodeJS.ReadableStream).pipe(res);
  } catch (error) {
    res.status(500).json({
      message: "Falha ao carregar arquivo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  }
});

export default router;
