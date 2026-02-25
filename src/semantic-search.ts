import PostalMime from "postal-mime";
import type { Kysely } from "kysely";
import { getDb } from "./db/client";
import type { Attachment, Database, Message } from "./db/schema";
import type { Env } from "./types";

const DEFAULT_EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
const EMBEDDING_GEMMA_MODEL = "@cf/google/embeddinggemma-300m";
const EMBEDDING_GEMMA_MAX_DIMENSIONS = 768;
const DEFAULT_VECTOR_NAMESPACE = "messages";
const MAX_DOCUMENT_CHARS = 6000;
const MAX_BODY_CHARS = 3600;
const MAX_ATTACHMENT_DOCUMENT_CHARS = 2200;
const MAX_ATTACHMENT_CHARS_PER_FILE = 1100;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const MAX_ATTACHMENT_BYTES = 512 * 1024;
const MAX_SUBJECT_CHARS = 220;
const MAX_ADDRESS_CHARS = 140;
const MAX_ATTACHMENT_NAME_CHARS = 120;
const MAX_SEMANTIC_CHUNK_CHARS = 780;
const SEMANTIC_CHUNK_OVERLAP_CHARS = 120;
const MAX_SEMANTIC_CHUNKS_PER_MESSAGE = 10;
const MAX_SEMANTIC_MATCH_CHUNKS = 3;
const MAX_SEMANTIC_CHUNK_METADATA_CHARS = 480;
const SEMANTIC_SCHEMA_VERSION = "chunk-v1";
const CHUNK_ID_SEPARATOR = "::chunk::";

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "xml",
  "yaml",
  "yml",
  "log",
  "html",
  "htm",
  "ics",
  "eml",
]);

const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "application/x-www-form-urlencoded",
  "message/rfc822",
]);

export type SearchableMessage = Pick<
  Message,
  | "id"
  | "thread_id"
  | "from"
  | "to"
  | "subject"
  | "body_text"
  | "direction"
  | "approved"
  | "archived"
  | "created_at"
>;

export const SEMANTIC_MESSAGE_COLUMNS = [
  "id",
  "thread_id",
  "from",
  "to",
  "subject",
  "body_text",
  "direction",
  "approved",
  "archived",
  "created_at",
] as const;

export interface SemanticMatch {
  id: string;
  score: number;
  chunks: SemanticMatchedChunk[];
}

export interface SemanticMatchedChunk {
  vector_id: string;
  score: number;
  chunk_index: number | null;
  text: string;
}

interface EmbeddingOutput {
  data?: unknown;
  shape?: unknown;
}

type AttachmentForSemanticIndex = Pick<
  Attachment,
  "id" | "filename" | "content_type" | "size" | "r2_key"
>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function clean(value: string, maxChars: number): string {
  return truncate(normalizeWhitespace(value), maxChars);
}

function baseMimeType(contentType: string | null): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function extensionFromFilename(filename: string | null): string {
  if (!filename) return "";
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).trim().toLowerCase() : "";
}

function isAttachedEmail(contentType: string | null, filename: string | null): boolean {
  return (
    baseMimeType(contentType) === "message/rfc822" ||
    extensionFromFilename(filename) === "eml"
  );
}

function isTextLikeAttachment(attachment: AttachmentForSemanticIndex): boolean {
  const mime = baseMimeType(attachment.content_type);
  if (isAttachedEmail(attachment.content_type, attachment.filename)) return true;
  if (mime.startsWith("text/")) return true;
  if (TEXT_ATTACHMENT_MIME_TYPES.has(mime)) return true;
  return TEXT_ATTACHMENT_EXTENSIONS.has(extensionFromFilename(attachment.filename));
}

function isLikelyBinaryText(value: string): boolean {
  if (!value) return false;
  const sample = value.slice(0, 2000);
  if (!sample) return false;

  let controlChars = 0;
  let replacementChars = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (code === 0xfffd) replacementChars += 1;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      controlChars += 1;
    }
  }

  return controlChars / sample.length > 0.02 || replacementChars / sample.length > 0.1;
}

function sliceArrayBuffer(buffer: ArrayBuffer, maxBytes: number): ArrayBuffer {
  return buffer.byteLength <= maxBytes ? buffer : buffer.slice(0, maxBytes);
}

async function extractAttachedEmailText(buffer: ArrayBuffer): Promise<string> {
  const parsed = await PostalMime.parse(buffer);
  const parts: string[] = [];

  if (parsed.subject) parts.push(`subject: ${clean(parsed.subject, 320)}`);
  if (parsed.from?.address) parts.push(`from: ${clean(parsed.from.address, 180)}`);
  if (parsed.to?.length) {
    parts.push(`to: ${clean(parsed.to.map((addr) => addr.address).join(", "), 220)}`);
  }
  if (parsed.text) parts.push(`body: ${clean(parsed.text, MAX_ATTACHMENT_CHARS_PER_FILE)}`);

  return clean(parts.join("\n"), MAX_ATTACHMENT_CHARS_PER_FILE);
}

function extractPlainTextAttachment(buffer: ArrayBuffer): string {
  const text = new TextDecoder().decode(new Uint8Array(buffer));
  if (isLikelyBinaryText(text)) return "";
  return clean(text, MAX_ATTACHMENT_CHARS_PER_FILE);
}

async function collectMessageAttachmentText(
  env: Env,
  db: Kysely<Database>,
  messageId: string
): Promise<string> {
  const attachments = (await db
    .selectFrom("attachments")
    .select(["id", "filename", "content_type", "size", "r2_key"])
    .where("message_id", "=", messageId)
    .orderBy("created_at", "asc")
    .execute()) as AttachmentForSemanticIndex[];

  if (attachments.length === 0) return "";

  const parts: string[] = [];

  for (const attachment of attachments) {
    if (parts.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    if (!isTextLikeAttachment(attachment)) continue;
    if (attachment.size && attachment.size > MAX_ATTACHMENT_BYTES * 4) continue;

    try {
      const object = await env.ATTACHMENTS.get(attachment.r2_key);
      if (!object) continue;

      const rawBuffer = await object.arrayBuffer();
      const limitedBuffer = sliceArrayBuffer(rawBuffer, MAX_ATTACHMENT_BYTES);

      let text = "";
      if (isAttachedEmail(attachment.content_type, attachment.filename)) {
        try {
          text = await extractAttachedEmailText(limitedBuffer);
        } catch {
          text = extractPlainTextAttachment(limitedBuffer);
        }
      } else {
        text = extractPlainTextAttachment(limitedBuffer);
      }

      if (!text) continue;

      const attachmentName = clean(
        attachment.filename ?? attachment.id,
        MAX_ATTACHMENT_NAME_CHARS
      );
      parts.push(`attachment ${attachmentName}: ${text}`);
    } catch (error) {
      console.warn("Failed to extract attachment text for semantic index", {
        messageId,
        attachmentId: attachment.id,
        error,
      });
    }
  }

  return truncate(parts.join("\n"), MAX_ATTACHMENT_DOCUMENT_CHARS);
}

function getEmbeddingModel(env: Env): string {
  const configured = env.VECTOR_EMBEDDING_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_EMBEDDING_MODEL;
}

function getNamespace(env: Env): string {
  const configured = env.VECTORIZE_NAMESPACE?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_VECTOR_NAMESPACE;
}

function modelRequiresClsPooling(model: string): boolean {
  return model.toLowerCase().startsWith("@cf/baai/bge-");
}

function modelSupportsDimensions(model: string): boolean {
  return model.toLowerCase() === EMBEDDING_GEMMA_MODEL;
}

function parseShape(shape: unknown): [number, number] | null {
  if (!Array.isArray(shape) || shape.length !== 2) return null;

  const rows = shape[0];
  const dimensions = shape[1];
  if (
    typeof rows !== "number" ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    typeof dimensions !== "number" ||
    !Number.isInteger(dimensions) ||
    dimensions < 1
  ) {
    return null;
  }

  return [rows, dimensions];
}

function isFiniteVector(values: unknown): values is number[] {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === "number" && Number.isFinite(value))
  );
}

function extractEmbeddingVector(result: EmbeddingOutput): number[] | null {
  const data = result.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const nested = data[0];
  if (isFiniteVector(nested)) return nested;
  if (!isFiniteVector(data)) return null;

  const shape = parseShape(result.shape);
  if (!shape) return data;

  const [, dimensions] = shape;
  if (data.length < dimensions) return null;
  return data.slice(0, dimensions);
}

function buildIndexDocument(message: SearchableMessage, attachmentText: string): string {
  const parts = [
    `subject: ${clean(message.subject, 320)}`,
    `from: ${clean(message.from, 180)}`,
    `to: ${clean(message.to, 180)}`,
    `direction: ${message.direction}`,
  ];

  if (message.body_text) {
    parts.push(`body: ${clean(message.body_text, MAX_BODY_CHARS)}`);
  }
  if (attachmentText) parts.push(`attachments: ${attachmentText}`);

  return truncate(parts.join("\n"), MAX_DOCUMENT_CHARS);
}

function buildChunkVectorId(messageId: string, chunkIndex: number): string {
  return `${messageId}${CHUNK_ID_SEPARATOR}${chunkIndex}`;
}

function parseChunkMessageId(vectorId: string): string {
  const index = vectorId.indexOf(CHUNK_ID_SEPARATOR);
  if (index < 0) return vectorId;
  return vectorId.slice(0, index);
}

function parseChunkIndex(vectorId: string): number | null {
  const index = vectorId.indexOf(CHUNK_ID_SEPARATOR);
  if (index < 0) return null;
  const raw = Number.parseInt(vectorId.slice(index + CHUNK_ID_SEPARATOR.length), 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function splitDocumentIntoSemanticChunks(document: string): string[] {
  const normalized = clean(document, MAX_DOCUMENT_CHARS);
  if (!normalized) return [];
  if (normalized.length <= MAX_SEMANTIC_CHUNK_CHARS) {
    return [normalized];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length && chunks.length < MAX_SEMANTIC_CHUNKS_PER_MESSAGE) {
    const hardEnd = Math.min(start + MAX_SEMANTIC_CHUNK_CHARS, normalized.length);
    let chunkEnd = hardEnd;

    if (hardEnd < normalized.length) {
      const whitespaceBoundary = normalized.lastIndexOf(" ", hardEnd);
      if (whitespaceBoundary > start + 60) {
        chunkEnd = whitespaceBoundary;
      }
    }

    const chunk = clean(normalized.slice(start, chunkEnd), MAX_SEMANTIC_CHUNK_CHARS);
    if (chunk) chunks.push(chunk);
    if (chunkEnd >= normalized.length) break;

    start = Math.max(chunkEnd - SEMANTIC_CHUNK_OVERLAP_CHARS, start + 1);
  }

  return chunks;
}

export async function buildSemanticChunksForMessage(
  env: Env,
  db: Kysely<Database>,
  message: SearchableMessage
): Promise<string[]> {
  const attachmentText = await collectMessageAttachmentText(env, db, message.id);
  const document = buildIndexDocument(message, attachmentText);
  if (!document) return [];
  return splitDocumentIntoSemanticChunks(document);
}

async function embedText(env: Env, text: string): Promise<number[] | null> {
  if (!semanticSearchEnabled(env)) return null;

  const model = getEmbeddingModel(env);
  const payload: Record<string, unknown> = { text };
  if (modelRequiresClsPooling(model)) payload.pooling = "cls";
  if (modelSupportsDimensions(model)) payload.dimensions = EMBEDDING_GEMMA_MAX_DIMENSIONS;

  const result = (await env.AI.run(model as any, payload as any)) as EmbeddingOutput;

  if (!result || typeof result !== "object") {
    throw new Error("Workers AI embedding call returned an invalid response");
  }

  const vector = extractEmbeddingVector(result);
  if (!vector) {
    throw new Error("Workers AI embedding call did not return numeric vectors");
  }

  return vector;
}

export function semanticSearchEnabled(
  env: Env
): env is Env & Required<Pick<Env, "AI" | "MESSAGE_VECTORS">> {
  return Boolean(env.AI && env.MESSAGE_VECTORS);
}

export async function indexMessageForSemanticSearch(
  env: Env,
  message: SearchableMessage,
  db?: Kysely<Database>
): Promise<boolean> {
  if (!semanticSearchEnabled(env)) return false;
  if (message.approved !== 1) return false;

  const queryDb = db ?? getDb(env.DB);
  const chunks = await buildSemanticChunksForMessage(env, queryDb, message);
  if (chunks.length === 0) return false;

  const vectors: VectorizeVector[] = [];
  for (const [chunkIndex, chunkText] of chunks.entries()) {
    const embedding = await embedText(env, chunkText);
    if (!embedding) continue;

    vectors.push({
      id: buildChunkVectorId(message.id, chunkIndex),
      namespace: getNamespace(env),
      values: embedding,
      metadata: {
        semantic_schema: SEMANTIC_SCHEMA_VERSION,
        message_id: message.id,
        chunk_index: chunkIndex,
        chunk_text: clean(chunkText, MAX_SEMANTIC_CHUNK_METADATA_CHARS),
        thread_id: message.thread_id,
        direction: message.direction,
        created_at: message.created_at,
        from: clean(message.from, MAX_ADDRESS_CHARS),
        subject: clean(message.subject, MAX_SUBJECT_CHARS),
      },
    });
  }

  if (vectors.length === 0) return false;
  await env.MESSAGE_VECTORS.upsert(vectors);

  // Cleanup legacy one-vector-per-message entries so hybrid/vector queries
  // prioritize chunk records with snippet metadata.
  try {
    await env.MESSAGE_VECTORS.deleteByIds([message.id]);
  } catch {
    // Ignore deletion failures; chunk vectors were already upserted.
  }

  return true;
}

export async function querySemanticMatches(
  env: Env,
  query: string,
  topK: number
): Promise<SemanticMatch[]> {
  if (!semanticSearchEnabled(env)) return [];

  const cleanQuery = clean(query, 1500);
  if (!cleanQuery) return [];

  const embedding = await embedText(env, cleanQuery);
  if (!embedding) return [];

  const matches = await env.MESSAGE_VECTORS.query(embedding, {
    topK,
    namespace: getNamespace(env),
    returnValues: false,
    returnMetadata: "all",
  });

  const grouped = new Map<string, SemanticMatch>();

  for (const match of matches.matches) {
    if (!Number.isFinite(match.score)) continue;

    const metadata = (match.metadata ?? {}) as Record<string, unknown>;
    const metadataMessageId = metadata.message_id;
    const messageId =
      typeof metadataMessageId === "string" && metadataMessageId.length > 0
        ? metadataMessageId
        : parseChunkMessageId(match.id);
    if (!messageId) continue;

    const metadataChunkIndex = metadata.chunk_index;
    const chunkIndex =
      typeof metadataChunkIndex === "number" && Number.isInteger(metadataChunkIndex)
        ? metadataChunkIndex
        : parseChunkIndex(match.id);

    const metadataChunkText = metadata.chunk_text;
    const chunkText =
      typeof metadataChunkText === "string"
        ? clean(metadataChunkText, MAX_SEMANTIC_CHUNK_METADATA_CHARS)
        : "";

    let result = grouped.get(messageId);
    if (!result) {
      result = { id: messageId, score: match.score, chunks: [] };
      grouped.set(messageId, result);
    } else if (match.score > result.score) {
      result.score = match.score;
    }

    if (!chunkText) continue;
    if (result.chunks.some((chunk) => chunk.vector_id === match.id)) continue;

    result.chunks.push({
      vector_id: match.id,
      score: match.score,
      chunk_index: chunkIndex,
      text: chunkText,
    });
  }

  const chunkMatches = [...grouped.values()]
    .map((match) => ({
      ...match,
      chunks: match.chunks
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SEMANTIC_MATCH_CHUNKS),
    }))
    .sort((a, b) => b.score - a.score);

  if (chunkMatches.length > 0) return chunkMatches;

  // Backward-compatibility: if vectors were indexed before chunk metadata schema,
  // still return semantic ids/scores until reindexing populates chunk snippets.
  const legacyMatches = await env.MESSAGE_VECTORS.query(embedding, {
    topK,
    namespace: getNamespace(env),
    returnValues: false,
    returnMetadata: "none",
  });

  const byMessageId = new Map<string, SemanticMatch>();
  for (const match of legacyMatches.matches) {
    if (!Number.isFinite(match.score)) continue;
    const messageId = parseChunkMessageId(match.id);
    const existing = byMessageId.get(messageId);
    if (!existing || match.score > existing.score) {
      byMessageId.set(messageId, { id: messageId, score: match.score, chunks: [] });
    }
  }

  return [...byMessageId.values()].sort((a, b) => b.score - a.score);
}

export async function backfillSemanticIndex(
  env: Env,
  db: Kysely<Database>,
  limit: number,
  offset: number,
  includeArchived: boolean
): Promise<{ indexed: number; scanned: number; enabled: boolean }> {
  if (!semanticSearchEnabled(env)) {
    return { indexed: 0, scanned: 0, enabled: false };
  }

  let query = db
    .selectFrom("messages")
    .select(SEMANTIC_MESSAGE_COLUMNS)
    .where("approved", "=", 1)
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset);

  if (!includeArchived) query = query.where("archived", "=", 0);

  const messages = (await query.execute()) as SearchableMessage[];
  let indexed = 0;

  for (const message of messages) {
    try {
      const wasIndexed = await indexMessageForSemanticSearch(env, message, db);
      if (wasIndexed) indexed += 1;
    } catch (error) {
      console.warn("Failed to index message embedding", { messageId: message.id, error });
    }
  }

  return { indexed, scanned: messages.length, enabled: true };
}

export async function indexSenderMessagesForSemanticSearch(
  env: Env,
  db: Kysely<Database>,
  senderEmail: string
): Promise<number> {
  if (!semanticSearchEnabled(env)) return 0;

  const messages = (await db
    .selectFrom("messages")
    .select(SEMANTIC_MESSAGE_COLUMNS)
    .where("from", "=", senderEmail)
    .where("approved", "=", 1)
    .execute()) as SearchableMessage[];

  let indexed = 0;
  for (const message of messages) {
    try {
      const wasIndexed = await indexMessageForSemanticSearch(env, message, db);
      if (wasIndexed) indexed += 1;
    } catch (error) {
      console.warn("Failed to index approved sender message", {
        senderEmail,
        messageId: message.id,
        error,
      });
    }
  }

  return indexed;
}
