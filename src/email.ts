import PostalMime from "postal-mime";
import { sql } from "kysely";
import { getDb } from "./db/client";
import { dispatchWebhook } from "./webhooks";
import type { Env } from "./types";

const DEFAULT_MAX_INBOUND_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MiB

function parseAllowedRecipients(value?: string): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((addr) => addr.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseByteLimit(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasPassingMailAuth(authResults: string | null): boolean {
  if (!authResults) return false;
  const value = authResults.toLowerCase();
  return (
    /\bdmarc=pass\b/.test(value) ||
    /\bdkim=pass\b/.test(value) ||
    /\bspf=pass\b/.test(value)
  );
}

function getAttachmentSize(content: unknown): number {
  if (typeof content === "string") {
    return new TextEncoder().encode(content).byteLength;
  }
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  return 0;
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
) {
  const allowedRecipients = parseAllowedRecipients(env.INBOUND_ALLOWED_RECIPIENTS);
  const recipient = message.to.toLowerCase();
  if (allowedRecipients.size > 0 && !allowedRecipients.has(recipient)) {
    message.setReject("Recipient is not allowed");
    return;
  }

  const maxInboundBytes = parseByteLimit(
    env.MAX_INBOUND_BYTES,
    DEFAULT_MAX_INBOUND_BYTES
  );
  if (message.rawSize > maxInboundBytes) {
    message.setReject("Message exceeds maximum allowed size");
    return;
  }

  const raw = new Response(message.raw);
  const arrayBuffer = await raw.arrayBuffer();
  if (arrayBuffer.byteLength > maxInboundBytes) {
    message.setReject("Message exceeds maximum allowed size");
    return;
  }

  const parsed = await PostalMime.parse(arrayBuffer);
  const maxAttachmentBytes = parseByteLimit(
    env.MAX_ATTACHMENT_BYTES,
    DEFAULT_MAX_ATTACHMENT_BYTES
  );
  const oversizedAttachment = parsed.attachments?.find((att) => {
    const size = getAttachmentSize(att.content);
    return size > maxAttachmentBytes;
  });
  if (oversizedAttachment) {
    message.setReject("Attachment exceeds maximum allowed size");
    return;
  }

  const db = getDb(env.DB);
  const now = Date.now();
  const msgId = crypto.randomUUID();

  const from = (parsed.from?.address ?? message.from).toLowerCase();
  const to = parsed.to?.[0]?.address ?? message.to;
  const cc = parsed.cc?.map((a) => a.address).join(", ") || null;
  const subject = parsed.subject ?? "(no subject)";
  const rfc822MessageId = parsed.messageId ?? null;
  const inReplyTo = parsed.inReplyTo ?? null;

  // Check if sender is approved
  const approvedSender = await db
    .selectFrom("approved_senders")
    .select("email")
    .where("email", "=", from)
    .executeTakeFirst();
  const autoApproveAll =
    (env.INBOUND_AUTO_APPROVE_ALL ?? "false").toLowerCase() === "true";
  const requireAuthPass =
    (env.INBOUND_REQUIRE_AUTH_PASS ?? "true").toLowerCase() !== "false";
  const authResults = message.headers.get("Authentication-Results");
  const senderAuthenticated = hasPassingMailAuth(authResults);
  if (!autoApproveAll && approvedSender && requireAuthPass && !senderAuthenticated) {
    console.warn(
      `Sender ${from} is allowlisted but Authentication-Results did not pass`
    );
  }

  const approved =
    autoApproveAll || (approvedSender && (!requireAuthPass || senderAuthenticated))
      ? 1
      : 0;

  // Threading: find existing thread by In-Reply-To or References
  let threadId: string | null = null;

  if (inReplyTo) {
    const existing = await db
      .selectFrom("messages")
      .select("thread_id")
      .where("message_id", "=", inReplyTo)
      .executeTakeFirst();
    if (existing) threadId = existing.thread_id;
  }

  if (!threadId && parsed.references) {
    // References is a space-separated list of Message-IDs
    const refs =
      typeof parsed.references === "string"
        ? parsed.references.split(/\s+/)
        : [];
    for (const ref of refs) {
      const existing = await db
        .selectFrom("messages")
        .select("thread_id")
        .where("message_id", "=", ref)
        .executeTakeFirst();
      if (existing) {
        threadId = existing.thread_id;
        break;
      }
    }
  }

  if (threadId) {
    // Update existing thread
    await db
      .updateTable("threads")
      .set({
        last_message_at: now,
        message_count: sql`message_count + 1` as any,
      })
      .where("id", "=", threadId)
      .execute();
  } else {
    // New thread
    threadId = crypto.randomUUID();
    await db
      .insertInto("threads")
      .values({
        id: threadId,
        subject,
        last_message_at: now,
        message_count: 1,
        created_at: now,
      })
      .execute();
  }

  // Store message
  const headersJson = JSON.stringify(
    parsed.headers.map((h) => ({ key: h.key, value: h.value }))
  );

  await db
    .insertInto("messages")
    .values({
      id: msgId,
      thread_id: threadId,
      message_id: rfc822MessageId,
      in_reply_to: inReplyTo,
      from,
      to,
      cc,
      bcc: null,
      subject,
      body_text: parsed.text ?? null,
      body_html: parsed.html ?? null,
      headers: headersJson,
      direction: "inbound",
      approved,
      status: null,
      archived: 0,
      created_at: now,
    })
    .execute();

  // Store attachments in R2
  if (parsed.attachments?.length) {
    for (const att of parsed.attachments) {
      const attId = crypto.randomUUID();
      const r2Key = `${msgId}/${attId}/${att.filename ?? "attachment"}`;

      const content = att.content as string | ArrayBuffer | Uint8Array;
      await env.ATTACHMENTS.put(r2Key, content);

      await db
        .insertInto("attachments")
        .values({
          id: attId,
          message_id: msgId,
          filename: att.filename ?? null,
          content_type: att.mimeType ?? null,
          size: getAttachmentSize(content),
          r2_key: r2Key,
          created_at: now,
        })
        .execute();
    }
  }

  // Dispatch webhook for inbound message
  if (env.WEBHOOK_URL) {
    ctx.waitUntil(
      dispatchWebhook(env.WEBHOOK_URL, env.WEBHOOK_SECRET, "message.received", {
        id: msgId,
        thread_id: threadId,
        from,
        to,
        subject,
        direction: "inbound",
        approved,
        created_at: now,
      })
    );
  }
}
