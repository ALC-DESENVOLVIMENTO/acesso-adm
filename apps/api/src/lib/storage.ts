import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

const endpoint = process.env.STORAGE_ENDPOINT_URL || process.env.STORAGE_ENDPOINT || "";
const region = process.env.STORAGE_REGION || "auto";
const bucket = process.env.STORAGE_BUCKET_NAME || "";
const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY || "";
const forcePathStyle = String(process.env.STORAGE_FORCE_PATH_STYLE || "true").toLowerCase() !== "false";

const hasStorageConfig = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

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

  const trimmed = value.trim().replace(/^\/+/, "");

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("storage/")) {
    return trimmed.slice("storage/".length);
  }

  if (trimmed.startsWith("api/storage/")) {
    return trimmed.slice("api/storage/".length);
  }

  return trimmed;
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
