/**
 * Pure scoring helpers shared by recall and tests. Scores are deliberately
 * separate from source and factual confidence: confidence affects the answer
 * decision, not how strongly a memory is activated by a query.
 */

export interface RetrievalDocument {
  summary?: string | null;
  text: string;
  tags?: string[];
  entities?: string[];
}

export interface RetrievalCandidate extends RetrievalDocument {
  createdAt: string;
  salience: number;
  activation: number;
  identityRelevance: number;
}

export interface RetrievalContext {
  now?: Date;
  currentGoal?: string;
  currentContext?: Record<string, unknown>;
}

export interface RetrievalScore {
  lexicalScore: number;
  recencyScore: number;
  goalScore: number;
  totalScore: number;
}

export const RECALL_WEIGHTS = {
  lexical: 0.5,
  recency: 0.1,
  salience: 0.1,
  activation: 0.1,
  identity: 0.1,
  goal: 0.1,
} as const;

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_WORD = /[\p{Letter}\p{Number}]+/gu;
const RECENCY_HALF_LIFE_DAYS = 30;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Produces CJK bigrams and Unicode latin/number words. Single CJK runs use
 * their one character so one-character queries remain searchable.
 */
export function extractTokens(value: string): Set<string> {
  const normalized = normalizeText(value);
  const tokens = new Set<string>();
  const cjkRuns = normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  ) ?? [];

  for (const run of cjkRuns) {
    const chars = [...run];
    if (chars.length === 1) {
      tokens.add(chars[0] as string);
      continue;
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.add(`${chars[index]}${chars[index + 1]}`);
    }
    for (const char of chars) {
      if (CJK_CHAR.test(char)) {
        tokens.add(char);
      }
    }
  }

  for (const match of normalized.matchAll(LATIN_WORD)) {
    const token = match[0];
    if (token && !CJK_CHAR.test(token)) {
      tokens.add(token);
    }
  }

  return tokens;
}

function tokenOverlap(queryTokens: Set<string>, field: string): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  const fieldTokens = extractTokens(field);
  let matches = 0;
  for (const token of queryTokens) {
    if (fieldTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.size;
}

export function lexicalScore(query: string, document: RetrievalDocument): number {
  const normalizedQuery = normalizeText(query);
  const queryTokens = extractTokens(normalizedQuery);
  if (queryTokens.size === 0) {
    return 0;
  }

  const summary = document.summary ?? "";
  const tags = document.tags?.join(" ") ?? "";
  const entities = document.entities?.join(" ") ?? "";
  const weightedOverlap =
    tokenOverlap(queryTokens, summary) * 0.35 +
    tokenOverlap(queryTokens, document.text) * 0.25 +
    tokenOverlap(queryTokens, tags) * 0.15 +
    tokenOverlap(queryTokens, entities) * 0.15;

  const searchable = normalizeText(
    [summary, document.text, tags, entities].join(" "),
  );
  const phraseBonus =
    normalizedQuery.length >= 2 && searchable.includes(normalizedQuery) ? 0.1 : 0;
  return clamp01(weightedOverlap + phraseBonus);
}

export function recencyScore(createdAt: string, now = new Date()): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  const ageDays = Math.max(0, now.getTime() - timestamp) / 86_400_000;
  return clamp01(0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS));
}

export function goalContextScore(
  currentGoal: string | undefined,
  currentContext: Record<string, unknown> | undefined,
  document: RetrievalDocument,
): number {
  const parts: string[] = [];
  if (currentGoal?.trim()) {
    parts.push(currentGoal);
  }
  if (currentContext && Object.keys(currentContext).length > 0) {
    try {
      parts.push(JSON.stringify(currentContext));
    } catch {
      // Unserializable context contributes no goal signal.
    }
  }
  if (parts.length === 0) {
    return 0;
  }
  return lexicalScore(parts.join(" "), document);
}

export function scoreCandidate(
  query: string,
  candidate: RetrievalCandidate,
  context: RetrievalContext = {},
): RetrievalScore {
  const lexical = lexicalScore(query, candidate);
  const recency = recencyScore(candidate.createdAt, context.now ?? new Date());
  const goal = goalContextScore(
    context.currentGoal,
    context.currentContext,
    candidate,
  );
  const total =
    lexical * RECALL_WEIGHTS.lexical +
    recency * RECALL_WEIGHTS.recency +
    clamp01(candidate.salience) * RECALL_WEIGHTS.salience +
    clamp01(candidate.activation) * RECALL_WEIGHTS.activation +
    clamp01(candidate.identityRelevance) * RECALL_WEIGHTS.identity +
    goal * RECALL_WEIGHTS.goal;

  return {
    lexicalScore: lexical,
    recencyScore: recency,
    goalScore: goal,
    totalScore: clamp01(total),
  };
}
