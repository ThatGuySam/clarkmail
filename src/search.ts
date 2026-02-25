import { sql, type Kysely } from "kysely";
import type { Database, Message } from "./db/schema";
import { querySemanticMatches, semanticSearchEnabled } from "./semantic-search";
import type { Env } from "./types";

const MIN_VECTOR_TOP_K = 20;
const VECTOR_TOP_K_MULTIPLIER = 4;
const HYBRID_KEYWORD_MULTIPLIER = 3;
const RRF_SMOOTHING = 60;

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

function reciprocalRank(rank: number): number {
  return 1 / (RRF_SMOOTHING + rank + 1);
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
  const keywordCandidates = await searchMessagesByKeyword(
    db,
    query,
    Math.max(limit, limit * HYBRID_KEYWORD_MULTIPLIER),
    includeArchived
  );

  const vectorMatches = await querySemanticMatches(env, query, vectorTopK(limit));
  if (vectorMatches.length === 0) return keywordCandidates.slice(0, limit);

  const fusedScores = new Map<string, number>();
  for (const [rank, message] of keywordCandidates.entries()) {
    fusedScores.set(message.id, (fusedScores.get(message.id) ?? 0) + reciprocalRank(rank));
  }
  for (const [rank, match] of vectorMatches.entries()) {
    fusedScores.set(match.id, (fusedScores.get(match.id) ?? 0) + reciprocalRank(rank));
  }

  const rankedIds = [...fusedScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  const messagesById = new Map(keywordCandidates.map((message) => [message.id, message]));
  const missingIds = rankedIds.filter((id) => !messagesById.has(id));
  if (missingIds.length > 0) {
    const fetched = await fetchApprovedMessagesById(db, missingIds, includeArchived);
    for (const [id, message] of fetched) {
      messagesById.set(id, message);
    }
  }

  const fused = orderById(rankedIds, messagesById, limit);
  return fused.length > 0 ? fused : keywordCandidates.slice(0, limit);
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
