import type { Kysely } from "kysely";
import type { Database, Message } from "./db/schema";
import type { Env } from "./types";

const DEFAULT_EMBEDDING_MODEL = "@cf/google/embeddinggemma-300m";
const EMBEDDING_GEMMA_MODEL = "@cf/google/embeddinggemma-300m";
const EMBEDDING_GEMMA_MAX_DIMENSIONS = 768;
const DEFAULT_VECTOR_NAMESPACE = "messages";
const MAX_DOCUMENT_CHARS = 6000;
const MAX_SUBJECT_CHARS = 220;
const MAX_ADDRESS_CHARS = 140;

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
}

interface EmbeddingOutput {
  data?: unknown;
  shape?: unknown;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function clean(value: string, maxChars: number): string {
  return truncate(normalizeWhitespace(value), maxChars);
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

function buildIndexDocument(message: SearchableMessage): string {
  const parts = [
    `subject: ${clean(message.subject, 320)}`,
    `from: ${clean(message.from, 180)}`,
    `to: ${clean(message.to, 180)}`,
    `direction: ${message.direction}`,
  ];

  if (message.body_text) {
    parts.push(`body: ${clean(message.body_text, MAX_DOCUMENT_CHARS)}`);
  }

  return truncate(parts.join("\n"), MAX_DOCUMENT_CHARS);
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
  message: SearchableMessage
): Promise<boolean> {
  if (!semanticSearchEnabled(env)) return false;
  if (message.approved !== 1) return false;

  const document = buildIndexDocument(message);
  if (!document) return false;

  const embedding = await embedText(env, document);
  if (!embedding) return false;

  await env.MESSAGE_VECTORS.upsert([
    {
      id: message.id,
      namespace: getNamespace(env),
      values: embedding,
      metadata: {
        thread_id: message.thread_id,
        direction: message.direction,
        created_at: message.created_at,
        from: clean(message.from, MAX_ADDRESS_CHARS),
        subject: clean(message.subject, MAX_SUBJECT_CHARS),
      },
    },
  ]);

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
    returnMetadata: "none",
  });

  return matches.matches
    .filter((match) => Number.isFinite(match.score))
    .map((match) => ({ id: match.id, score: match.score }));
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
      const wasIndexed = await indexMessageForSemanticSearch(env, message);
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
      const wasIndexed = await indexMessageForSemanticSearch(env, message);
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
