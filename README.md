# 바이브 코딩 체험 (교사 연수용)

가입 없이 **연수 코드 + 닉네임**만으로 입장해, 한국어 요청으로 수업용 웹앱을 만들어 보는 연수 도구입니다.
강사의 Claude API 키 하나로 20명 내외가 동시에 체험하며, 작품은 서버에 저장되어 갤러리와 QR로 공유됩니다.

- 실행 환경: **Cloudflare Workers + D1** (학교 무선망에서 비교적 잘 열리는 Cloudflare 도메인 사용)
- AI 모델: **Claude Opus 5.5** 기본 (대시보드에서 연수별로 변경 가능)
- 참가자 화면 `/` · 갤러리 `/gallery.html` · 강사 대시보드 `/admin.html` · 작품 보기 `/w/작품id`

## 구성

```
src/index.ts      API 라우터 (입장, 대화 스트리밍, 작품 저장, 갤러리, 관리자)
src/claude.ts     고정 시스템 프롬프트, Claude 스트리밍 호출, 비용 계산, 모의 응답
src/util.ts       공통 함수 (코드 생성, 관리자 인증, CSV 등)
public/           참가자 화면(index.html, app.js), 갤러리, 대시보드, 시작 템플릿(templates.js)
schema.sql        D1 테이블 (codes, participants, turns, works)
wrangler.toml     Cloudflare 설정
```

API 키는 서버(Worker)에만 있고 브라우저로 내려가지 않습니다. 참가자가 만든 앱은 `sandbox` 격리 상태로만 실행됩니다.

## 처음 배포하기 (약 10분)

사전 준비: Node.js 20 이상, Cloudflare 계정(무료), Claude API 키.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create vibe-workshop-db
```

위 명령이 출력하는 `database_id` 값을 `wrangler.toml`의 `REPLACE_WITH_YOUR_DATABASE_ID` 자리에 붙여 넣습니다. 그 다음 테이블을 만듭니다.

```bash
npm run db:remote
```

비밀값 두 개를 등록합니다. (입력창이 뜨면 값을 붙여 넣으세요)

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

```bash
npx wrangler secret put ADMIN_PASSWORD
```

배포합니다.

```bash
npm run deploy
```

출력되는 `https://vibe-coding-workshop.<계정>.workers.dev` 주소가 참가자용 주소입니다.

## 연수 당일 운영 순서

1. `/admin.html` 접속 → 관리자 비밀번호 로그인
2. "새 연수 코드 만들기"에서 연수 이름, 유효 시간, 1인당 요청 횟수, 예산 상한을 정하고 **코드 생성**
3. 생성된 6자리 코드를 화면에 띄우거나, 상세 화면의 **참가자 입장 링크**(코드가 미리 채워진 주소)를 QR로 공유
4. 참가자는 코드와 닉네임을 입력하고 바로 시작. 시작 템플릿(모둠 뽑기, 타이머, CER 글쓰기 등)을 눌러 첫 요청을 보냄
5. 참가자가 **저장·공유**를 누르면 갤러리(`/gallery.html?code=코드`)에 나타남. 교실 TV에 갤러리를 띄워 공유 활동 진행
6. 연수 후 대시보드의 **대화 기록 CSV**를 내려받아 성찰 자료로 활용

대시보드에서 언제든 **일시 중지**, **예산 변경**, **+3시간 연장**이 가능합니다.

## 비용과 제한

| 항목 | 기본값 | 비고 |
|---|---|---|
| 1인당 요청 횟수 | 60회 | 코드 생성 시 조정 |
| 분당 요청 횟수 | 6회 | 과도한 연타 방지 |
| 연수 예산 상한 | 30 USD | 초과 시 요청 차단, 강사가 올릴 수 있음 |
| 사고 깊이(effort) | medium | low로 바꾸면 더 빠르고 저렴 |

20명 × 15회 요청 기준으로 Opus 5.5는 대략 20~30 USD 안팎이 듭니다. 실제 비용은 대시보드에 요청마다 기록됩니다.

Cloudflare 무료 요금제로 운영 가능하지만, 응답 중 "CPU limit exceeded" 오류가 자주 보이면 Workers 유료 요금제(월 5 USD)로 바꾸면 해결됩니다.

## 로컬에서 미리 보기 (선택)

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars`에서 `MOCK_AI=1`로 두면 API 키 없이 모의 응답으로 화면 흐름을 확인할 수 있습니다. 실제 Claude 응답을 보려면 키를 넣고 `MOCK_AI=0`으로 둡니다.

```bash
npm run db:local
```

```bash
npm run dev
```

`http://localhost:8787` 에서 확인합니다. 관리자 비밀번호는 `.dev.vars`의 값을 씁니다.

## 바꾸고 싶을 때

- 시작 템플릿: `public/templates.js`
- 앱 생성 규칙(시스템 프롬프트): `src/claude.ts`의 `SYSTEM_PROMPT`
- 기본 모델·환율: `wrangler.toml`의 `[vars]`

## 알아 둘 점

- 같은 연수 코드 안에서 닉네임은 하나만 쓸 수 있습니다. 기기를 바꾸면 다른 닉네임으로 입장합니다.
- 참가자의 대화와 앱은 브라우저에 저장되어 새로고침해도 유지되며, "나가기"를 누르면 지워집니다. 서버에는 저장한 작품과 대화 기록이 남습니다.
- 작품 주소(`/w/작품id`)는 주소를 아는 누구나 열 수 있으니, 개인정보가 담긴 앱은 저장하지 않도록 안내해 주세요.
