/**
 * Threading rules (§6.5), as pure logic. The Worker supplies lookups
 * against D1; this module decides.
 */

const SUBJECT_PREFIX_RE =
  /^\s*((re|fwd?|fw|aw|sv|vs|antw|tr)(\[\d+\])?\s*:\s*)+/i;

export function normalizeSubject(subject: string): string {
  return subject.replace(SUBJECT_PREFIX_RE, "").trim().toLowerCase();
}

export interface ThreadCandidate {
  thread_id: string;
  normalized_subject: string;
  participants: string[];
  last_message_at: string; // ISO
}

export interface ThreadResolutionInput {
  /** thread_id found by Message-ID lookup of In-Reply-To/References, if any */
  referencedThreadId: string | null;
  subject: string;
  participants: string[];
  /** candidate threads in the same inbox with recent activity */
  candidates: ThreadCandidate[];
  now?: Date;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type ThreadResolution =
  | { kind: "existing"; thread_id: string }
  | { kind: "new" };

export function resolveThread(input: ThreadResolutionInput): ThreadResolution {
  if (input.referencedThreadId) {
    return { kind: "existing", thread_id: input.referencedThreadId };
  }
  const normalized = normalizeSubject(input.subject);
  if (normalized.length === 0) return { kind: "new" };
  const now = (input.now ?? new Date()).getTime();
  const participantSet = new Set(input.participants.map((p) => p.toLowerCase()));
  for (const candidate of input.candidates) {
    if (candidate.normalized_subject !== normalized) continue;
    if (now - new Date(candidate.last_message_at).getTime() > THIRTY_DAYS_MS) continue;
    const overlap = candidate.participants.some((p) =>
      participantSet.has(p.toLowerCase())
    );
    if (overlap) return { kind: "existing", thread_id: candidate.thread_id };
  }
  return { kind: "new" };
}

/** Parse the References/In-Reply-To header values into message-ids. */
export function parseMessageIdRefs(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];
  const matches = headerValue.match(/<[^<>]+>/g);
  return matches ?? [];
}
