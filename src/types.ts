export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  ADMIN_PASSWORD: string;
  DEFAULT_MODEL: string;
  DEFAULT_EFFORT: string;
  USD_TO_KRW: string;
  MOCK_AI?: string;
}

export type Effort = "low" | "medium" | "high";

export interface CodeRow {
  code: string;
  label: string;
  created_at: number;
  expires_at: number;
  active: number;
  model: string;
  effort: Effort;
  max_turns_per_user: number;
  per_minute: number;
  budget_usd: number;
}

export interface ParticipantRow {
  id: string;
  code: string;
  nickname: string;
  created_at: number;
  last_seen: number;
}

export interface WorkRow {
  id: string;
  code: string;
  participant_id: string;
  nickname: string;
  title: string;
  description: string;
  html: string;
  created_at: number;
  updated_at: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}
