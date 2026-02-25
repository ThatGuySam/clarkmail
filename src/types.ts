// ---------------------------------------------------------------------------
// Cloudflare Email Service types (private beta — not yet in @cloudflare/workers-types)
// ---------------------------------------------------------------------------

export interface EmailServiceAttachment {
  content: string; // base64-encoded
  filename: string;
  type: string; // MIME type
  disposition: "attachment" | "inline";
  contentId?: string;
}

export interface EmailServiceMessage {
  to: string | string[];
  from: string | { email: string; name: string };
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | { email: string; name: string };
  attachments?: EmailServiceAttachment[];
  headers?: Record<string, string>;
}

export interface EmailServiceResponse {
  messageId: string;
  success: boolean;
}

export interface EmailServiceError {
  success: false;
  error: { code: string; message: string };
}

export interface EmailBinding {
  send(message: EmailServiceMessage): Promise<EmailServiceResponse>;
  sendBatch(
    messages: EmailServiceMessage[]
  ): Promise<{ results: (EmailServiceResponse | EmailServiceError)[] }>;
}

// ---------------------------------------------------------------------------
// Worker environment
// ---------------------------------------------------------------------------

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  MCP_OBJECT: DurableObjectNamespace;
  /** Workers AI binding (for semantic embeddings) */
  AI?: Ai;
  /** Vectorize index binding for semantic message search */
  MESSAGE_VECTORS?: Vectorize;
  API_KEY: string;
  /** Cloudflare Email Service binding (send_email in wrangler config) */
  EMAIL?: EmailBinding;
  /** Resend API key — required when EMAIL_PROVIDER is "resend" */
  RESEND_API_KEY?: string;
  /** "cloudflare" | "resend" — auto-detected from bindings if omitted */
  EMAIL_PROVIDER?: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  REPLY_TO_EMAIL?: string;
  /** Resend-specific overrides (falls back to FROM_EMAIL / FROM_NAME / REPLY_TO_EMAIL) */
  RESEND_FROM_EMAIL?: string;
  RESEND_FROM_NAME?: string;
  RESEND_REPLY_TO_EMAIL?: string;
  /** Comma-separated envelope recipients allowed for inbound processing */
  INBOUND_ALLOWED_RECIPIENTS?: string;
  /** Set to "true" to auto-approve all inbound senders (disables sender allowlist gate) */
  INBOUND_AUTO_APPROVE_ALL?: string;
  /** Set to "false" to skip SPF/DKIM/DMARC pass requirement for allowlisted senders */
  INBOUND_REQUIRE_AUTH_PASS?: string;
  /** Max raw inbound message size in bytes (defaults to 10 MiB) */
  MAX_INBOUND_BYTES?: string;
  /** Max single attachment size in bytes (defaults to 5 MiB) */
  MAX_ATTACHMENT_BYTES?: string;
  /** Workers AI embedding model slug (defaults to @cf/google/embeddinggemma-300m) */
  VECTOR_EMBEDDING_MODEL?: string;
  /** Vectorize namespace to store message vectors in (defaults to "messages") */
  VECTORIZE_NAMESPACE?: string;
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
  RESEND_WEBHOOK_SECRET?: string;
  /** Resend svix signing secret for webhook signature verification */
  RESEND_WEBHOOK_SIGNING_SECRET?: string;
}
