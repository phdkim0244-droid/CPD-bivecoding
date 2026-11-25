-- 연수 코드 (강사가 생성)
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL,
  effort TEXT NOT NULL DEFAULT 'medium',
  max_turns_per_user INTEGER NOT NULL DEFAULT 60,
  per_minute INTEGER NOT NULL DEFAULT 6,
  budget_usd REAL NOT NULL DEFAULT 30
);

-- 참가자 (가입 없음: 연수 코드 + 닉네임)
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  UNIQUE(code, nickname)
);

-- 대화 기록 (요청 1회 = 1행)
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  stop_reason TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_participant ON turns(participant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_code ON turns(code, created_at);

-- 참가자 작품 (서버 저장, 갤러리/공유용)
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_works_code ON works(code, updated_at);
