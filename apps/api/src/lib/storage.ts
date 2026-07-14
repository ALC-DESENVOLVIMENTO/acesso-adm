import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

function readStorageEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (!value) {
      continue;
    }

    const lowered = value.toLowerCase();

    if (lowered === "undefined" || lowered === "null" || lowered === "") {
      continue;
    }

    return value;
  }

  return "";
}

function hasValidEndpoint(candidate: string) {
  if (!candidate) {
    return false;
  }

  try {
    const parsed = new URL(candidate);
    return Boolean(parsed.protocol && parsed.host);
  } catch {
    return false;
  }
}

const endpoint = readStorageEnv(
  "STORAGE_ENDPOINT_URL",
  "STORAGE_ENDPOINT",
  "STORAGE_URL",
  "S3_ENDPOINT_URL",
  "S3_ENDPOINT",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT"
) || "";
const region =
  process.env.STORAGE_REGION ||
  process.env.S3_REGION ||
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "auto";
const bucket =
  readStorageEnv(
    "STORAGE_BUCKET_NAME",
    "STORAGE_BUCKET",
    "STORAGE_BUCKET_ID",
    "S3_BUCKET_NAME",
    "S3_BUCKET",
    "AWS_BUCKET"
  ) ||
  "";
const accessKeyId =
  readStorageEnv(
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_ACCESS_KEY",
    "S3_ACCESS_KEY_ID",
    "AWS_ACCESS_KEY_ID",
    "AWS_ACCESS_KEY"
  ) ||
  "";
const secretAccessKey =
  readStorageEnv(
    "STORAGE_SECRET_ACCESS_KEY",
    "STORAGE_SECRET_KEY",
    "STORAGE_SECRET",
    "S3_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SECRET",
    "SECRET_ACCESS_KEY"
  ) ||
  "";
const forcePathStyle = String(process.env.STORAGE_FORCE_PATH_STYLE || "true").toLowerCase() !== "false";

const hasStorageConfig = Boolean(hasValidEndpoint(endpoint) && bucket && accessKeyId && secretAccessKey);
const missingStorageConfig: string[] = [];
if (!bucket) {
  missingStorageConfig.push("bucket");
}
if (!accessKeyId) {
  missingStorageConfig.push("access key");
}
if (!secretAccessKey) {
  missingStorageConfig.push("secret key");
}
if (!hasValidEndpoint(endpoint)) {
  missingStorageConfig.push("endpoint");
}
const storageConfigSource = hasStorageConfig ? "configured" : "missing variables";
const endpointPreview = endpoint ? endpoint.replace(/\/\/.*@/, "//***@") : null;

export function getStorageDiagnostics() {
  return {
    configured: hasStorageConfig,
    endpoint: endpointPreview,
    bucket,
    region,
    forcePathStyle,
    missing: missingStorageConfig
  };
}

const client = hasStorageConfig
  ? new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey
      }
    })
  : null;

function encodePathSegment(segment: string) {
  return encodeURIComponent(segment).replace(/%2F/g, "/");
}

export function hasObjectStorage() {
  return Boolean(client);
}

export function normalizeStorageKey(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return normalizeStorageKey(parsed.pathname);
    } catch {
      return null;
    }
  }

  const normalizedPath = trimmed.replace(/^\/+/, "");

  if (normalizedPath.startsWith("storage/")) {
    return normalizedPath.slice("storage/".length);
  }

  if (normalizedPath.startsWith("api/storage/")) {
    return normalizedPath.slice("api/storage/".length);
  }

  return normalizedPath;
}

export function isPaymentMirrorStorageKey(value: string | null | undefined) {
  const normalized = normalizeStorageKey(value);
  return Boolean(normalized && normalized.startsWith("uploads/"));
}

export function assertPaymentMirrorStorageKey(value: string | null | undefined) {
  const normalized = normalizeStorageKey(value);

  if (!normalized || !normalized.startsWith("uploads/")) {
    throw new Error("Caminho invalido para PDF do espelho de pagamento.");
  }

  return normalized;
}

export function buildStorageObjectUrl(key: string | null | undefined) {
  const normalized = normalizeStorageKey(key);
  return normalized ? `/api/storage/${normalized.split("/").map(encodePathSegment).join("/")}` : null;
}

export function createStorageKey(folder: string, originalName: string) {
  const safeBaseName = originalName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
  return `${cleanFolder}/${Date.now()}-${safeBaseName}`;
}

export async function uploadObject(params: {
  key: string;
  body: Buffer | Uint8Array | Readable | Blob | string;
  contentType?: string;
  cacheControl?: string;
}) {
  if (!client) {
    throw new Error("Configuracao de storage nao encontrada.");
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      CacheControl: params.cacheControl
    })
  );
}

export async function deleteObject(key: string | null | undefined) {
  const normalized = normalizeStorageKey(key);

  if (!client || !normalized) {
    return;
  }

  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: normalized
    })
  );
}

export async function fetchObjectBuffer(key: string | null | undefined) {
  const normalized = normalizeStorageKey(key);

  if (!client || !normalized) {
    return null;
  }

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: normalized
    })
  );

  if (!response.Body) {
    return null;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as Readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return {
    body: Buffer.concat(chunks),
    contentType: response.ContentType || null,
    contentLength: response.ContentLength || null
  };
}

export async function fetchObjectStream(key: string | null | undefined) {
  const normalized = normalizeStorageKey(key);

  if (!client || !normalized) {
    return null;
  }

  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: normalized
    })
  );

  return response;
}

export async function storageObjectExists(key: string | null | undefined) {
  const normalized = normalizeStorageKey(key);

  if (!client || !normalized) {
    return false;
  }

  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: normalized
      })
    );
    return true;
  } catch {
    return false;
  }
}
