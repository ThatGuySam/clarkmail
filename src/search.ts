import { sql, type Kysely } from "kysely";
import type { Database, Message } from "./db/schema";
import { querySemanticMatches, semanticSearchEnabled } from "./semantic-search";
import type { Env } from "./types";

const MIN_VECTOR_TOP_K = 20;
const VECTOR_TOP_K_MULTIPLIER = 4;

export type SearchMode = "keyword" | "vector" | "hybrid";

export function parseSearchMode(value: string | undefined): SearchMode | null {
  if (!value) return null;
  if (value === "keyword" || value === "vector" || value === "hybrid") {
    return value;
  }
  return null;
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

async function searchMessagesByKeyword(
  db: Kysely<Database>,
  query: string,
  limit: number,
  includeArchived: boolean
): Promise<Message[]> {
  try {
    const archivedFilter = includeArchived ? sql`1=1` : sql`m.archived = 0`;
    const results = await sql`
      SELECT m.* FROM messages m
      JOIN messages_fts f ON f.message_id = m.id
      WHERE f MATCH ${query}
      AND m.approved = 1
      AND ${archivedFilter}
      ORDER BY rank
      LIMIT ${limit}
    `.execute(db);
    return results.rows as Message[];
  } catch {
    // Fallback to LIKE search if FTS query syntax is invalid
    const escaped = escapeLike(query);
    let q = db
      .selectFrom("messages")
      .selectAll()
      .where("approved", "=", 1)
      .where((eb) =>
        eb.or([
          eb("subject", "like", `%${escaped}%`),
          eb("body_text", "like", `%${escaped}%`),
        ])
      )
      .orderBy("created_at", "desc")
      .limit(limit);

    if (!includeArchived) q = q.where("archived", "=", 0);
    return await q.execute();
  }
}

async function fetchApprovedMessagesById(
  db: Kysely<Database>,
  ids: string[],
  includeArchived: boolean
): Promise<Map<string, Message>> {
  if (ids.length === 0) return new Map();
  const uniqueIds = [...new Set(ids)];

  let query = db
    .selectFrom("messages")
    .selectAll()
    .where("approved", "=", 1)
    .where("id", "in", uniqueIds);

  if (!includeArchived) query = query.where("archived", "=", 0);
  const rows = await query.execute();
  return new Map(rows.map((row) => [row.id, row]));
}

function orderById(
  ids: string[],
  messages: Map<string, Message>,
  limit: number
): Message[] {
  const ordered: Message[] = [];
  for (const id of ids) {
    const message = messages.get(id);
    if (!message) continue;
    ordered.push(message);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

function vectorTopK(limit: number): number {
  return Math.max(MIN_VECTOR_TOP_K, limit * VECTOR_TOP_K_MULTIPLIER);
}

async function searchMessagesByVector(
  db: Kysely<Database>,
  env: Env,
  query: string,
  limit: number,
  includeArchived: boolean
): Promise<Message[]> {
  const matches = await querySemanticMatches(env, query, vectorTopK(limit));
  if (matches.length === 0) return [];

  const ids = matches.map((match) => match.id);
  const messagesById = await fetchApprovedMessagesById(db, ids, includeArchived);
  return orderById(ids, messagesById, limit);
}

async function searchMessagesHybrid(
  db: Kysely<Database>,
  env: Env,
  query: string,
  limit: number,
  includeArchived: boolean
): Promise<Message[]> {
  const keywordCandidates = await searchMessagesByKeyword(db, query, limit, includeArchived);

  const vectorMatches = await querySemanticMatches(env, query, vectorTopK(limit));
  if (vectorMatches.length === 0) return keywordCandidates.slice(0, limit);

  const messagesById = new Map(keywordCandidates.map((message) => [message.id, message]));
  const vectorIds = vectorMatches.map((match) => match.id);
  const missingIds = vectorIds.filter((id) => !messagesById.has(id));
  if (missingIds.length > 0) {
    const fetched = await fetchApprovedMessagesById(db, missingIds, includeArchived);
    for (const [id, message] of fetched) {
      messagesById.set(id, message);
    }
  }

  const orderedIds: string[] = [];
  const seen = new Set<string>();

  for (const message of keywordCandidates) {
    if (seen.has(message.id)) continue;
    orderedIds.push(message.id);
    seen.add(message.id);
  }

  for (const id of vectorIds) {
    if (seen.has(id)) continue;
    orderedIds.push(id);
    seen.add(id);
  }

  return orderById(orderedIds, messagesById, limit);
}

export async function searchMessages(
  db: Kysely<Database>,
  env: Env,
  query: string,
  limit: number,
  includeArchived: boolean,
  mode: SearchMode = "hybrid"
): Promise<Message[]> {
  if (mode === "keyword" || !semanticSearchEnabled(env)) {
    return await searchMessagesByKeyword(db, query, limit, includeArchived);
  }

  try {
    if (mode === "vector") {
      return await searchMessagesByVector(db, env, query, limit, includeArchived);
    }

    return await searchMessagesHybrid(db, env, query, limit, includeArchived);
  } catch (error) {
    console.warn("Semantic search failed, falling back to keyword search", error);
    return await searchMessagesByKeyword(db, query, limit, includeArchived);
  }
}
