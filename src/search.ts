import { sql, type Kysely } from "kysely";
import type { Database, Message } from "./db/schema";
import type { SemanticMatch, SemanticMatchedChunk, SearchableMessage } from "./semantic-search";
import {
  buildSemanticChunksForMessage,
  querySemanticMatches,
  semanticSearchEnabled,
} from "./semantic-search";
import type { Env } from "./types";

const MIN_VECTOR_TOP_K = 40;
const VECTOR_TOP_K_MULTIPLIER = 8;

export type SearchMode = "keyword" | "vector" | "hybrid";

export type SearchResult = Message & {
  semantic_score?: number;
  semantic_matches?: SemanticMatchedChunk[];
};

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

function toSemanticLookup(matches: SemanticMatch[]): Map<string, SemanticMatch> {
  return new Map(matches.map((match) => [match.id, match]));
}

function withSemanticMatches(
  messages: Message[],
  semanticMatches: Map<string, SemanticMatch>
): SearchResult[] {
  return messages.map((message) => {
    const match = semanticMatches.get(message.id);
    if (!match) return message;

    return {
      ...message,
      semantic_score: match.score,
      semantic_matches: match.chunks,
    };
  });
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function lexicalChunkScore(chunk: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (lower.includes(token)) score += 1;
  }
  return score / queryTokens.length;
}

function buildReconstructedMatches(
  messageId: string,
  semanticScore: number,
  chunks: string[],
  query: string
): SemanticMatchedChunk[] {
  const queryTokens = tokenizeQuery(query);
  const ranked = chunks.map((text, index) => ({
    text,
    index,
    lexical_score: lexicalChunkScore(text, queryTokens),
  }));

  ranked.sort((a, b) => {
    if (b.lexical_score !== a.lexical_score) return b.lexical_score - a.lexical_score;
    return a.index - b.index;
  });

  return ranked.slice(0, 3).map((chunk, position) => ({
    vector_id: `${messageId}::chunk::${chunk.index}`,
    score: Math.max(0, semanticScore - position * 0.0001),
    chunk_index: chunk.index,
    text: chunk.text,
  }));
}

async function hydrateMissingSemanticMatches(
  db: Kysely<Database>,
  env: Env,
  query: string,
  results: SearchResult[]
): Promise<SearchResult[]> {
  const next = [...results];

  for (let index = 0; index < next.length; index += 1) {
    const result = next[index];
    if (typeof result.semantic_score !== "number") continue;
    if ((result.semantic_matches?.length ?? 0) > 0) continue;

    try {
      const chunks = await buildSemanticChunksForMessage(
        env,
        db,
        result as SearchableMessage
      );
      if (chunks.length === 0) continue;

      next[index] = {
        ...result,
        semantic_matches: buildReconstructedMatches(
          result.id,
          result.semantic_score,
          chunks,
          query
        ),
      };
    } catch (error) {
      console.warn("Failed to reconstruct semantic chunk matches", {
        messageId: result.id,
        error,
      });
    }
  }

  return next;
}

async function searchMessagesByVector(
  db: Kysely<Database>,
  env: Env,
  query: string,
  limit: number,
  includeArchived: boolean
): Promise<SearchResult[]> {
  const matches = await querySemanticMatches(env, query, vectorTopK(limit));
  if (matches.length === 0) return [];

  const ids = matches.map((match) => match.id);
  const messagesById = await fetchApprovedMessagesById(db, ids, includeArchived);
  const orderedMessages = orderById(ids, messagesById, limit);
  const enriched = withSemanticMatches(orderedMessages, toSemanticLookup(matches));
  return await hydrateMissingSemanticMatches(db, env, query, enriched);
}

async function searchMessagesHybrid(
  db: Kysely<Database>,
  env: Env,
  query: string,
  limit: number,
  includeArchived: boolean
): Promise<SearchResult[]> {
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

  const orderedMessages = orderById(orderedIds, messagesById, limit);
  const enriched = withSemanticMatches(orderedMessages, toSemanticLookup(vectorMatches));
  return await hydrateMissingSemanticMatches(db, env, query, enriched);
}

export async function searchMessages(
  db: Kysely<Database>,
  env: Env,
  query: string,
  limit: number,
  includeArchived: boolean,
  mode: SearchMode = "hybrid"
): Promise<SearchResult[]> {
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
