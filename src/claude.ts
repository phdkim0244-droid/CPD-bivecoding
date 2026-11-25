import Anthropic from "@anthropic-ai/sdk";
import type { Effort, Usage } from "./types";

// 참가자가 바꿀 수 없는 고정 시스템 프롬프트.
// 내용이 바뀌지 않아야 프롬프트 캐시가 유지되므로 날짜나 닉네임 같은 변하는 값은 넣지 않습니다.
export const SYSTEM_PROMPT = `당신은 초등학교 교사 연수에서 "바이브 코딩"을 처음 체험하는 선생님들을 돕는 웹앱 제작 도우미입니다.
선생님은 코딩을 모른다고 가정하고, 한국어 요청을 받아 수업에서 바로 쓸 수 있는 작은 웹앱을 만들어 줍니다.

## 답변 형식 (반드시 지킬 것)
1. 먼저 한국어로 2~3문장: 무엇을 만들었거나 바꿨는지, 그리고 다음에 해 볼 만한 수정 요청 한 가지를 제안합니다.
2. 그 다음 \`\`\`html 로 시작해 \`\`\` 로 끝나는 코드 블록 하나에 **완성된 HTML 파일 전체**를 넣습니다.
3. 코드 블록 뒤에는 아무것도 쓰지 않습니다.
코드 블록은 항상 정확히 하나만 출력합니다. 수정 요청일 때도 바뀐 부분만이 아니라 파일 전체를 다시 출력합니다.

## 웹앱 제작 규칙
- 파일 하나로 동작해야 합니다: HTML, CSS, JavaScript를 모두 한 파일 안에 넣습니다.
- 외부 자원을 쓰지 않습니다: CDN 라이브러리, 웹폰트, 외부 이미지, 외부 API 호출 금지. 학교 네트워크에서 막히는 경우가 많습니다. 아이콘이 필요하면 이모지나 인라인 SVG를 씁니다.
- 화면 글자는 한국어로 쓰고, 초등학생과 교사가 쓰기 좋게 글자와 버튼을 크게, 색은 밝고 또렷하게 만듭니다.
- 스마트폰, 태블릿, 교실 TV(큰 화면)에서 모두 보기 좋게 반응형으로 만듭니다.
- 저장이 필요하면 localStorage를 try/catch로 감싸서 쓰고, 안 되어도 앱이 동작하게 합니다.
- alert, prompt, confirm 대신 화면 안의 요소로 안내합니다.
- 수정 요청을 받으면 요청한 부분만 바꾸고 나머지 기능과 디자인은 그대로 유지합니다.
- 요청이 모호하면 질문하지 말고 수업 상황에 맞는 합리적인 선택을 한 뒤, 첫 문장에서 그렇게 했다고 짧게 알립니다.
- 학교와 수업에 어울리는 내용만 만듭니다. 부적절한 요청이면 코드 없이 한국어로 정중히 이유를 설명합니다.`;

export interface ChatInput {
  prompt: string;
  currentHtml?: string;
  priorPrompts?: string[];
}

export function buildUserMessage(input: ChatInput): string {
  const prompt = input.prompt.trim();
  const html = (input.currentHtml ?? "").trim();
  if (!html) return `요청: ${prompt}`;

  const prior = (input.priorPrompts ?? []).slice(-8);
  const priorText = prior.length
    ? `지금까지의 요청 순서:\n${prior.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\n`
    : "";
  return `${priorText}현재 앱의 전체 코드:\n\`\`\`html\n${html}\n\`\`\`\n\n새 요청: ${prompt}`;
}

// 1M 토큰당 달러. 관리자가 모델을 바꿀 수 있으므로 몇 가지를 미리 둡니다.
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function estimateCost(model: string, u: Omit<Usage, "cost_usd">): number {
  const p = PRICING[model] ?? PRICING["claude-opus-5-5"];
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_tokens * p.cacheRead +
      u.cache_write_tokens * p.cacheWrite) /
    1_000_000
  );
}

export interface StreamResult {
  text: string;
  stopReason: string | null;
  refusalCategory: string | null;
  servedModel: string;
  usage: Usage;
}

export interface StreamOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  input: ChatInput;
  onText: (chunk: string) => Promise<void> | void;
}

export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });

  const stream = client.beta.messages.stream({
    model: opts.model,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    // 안전 분류기가 요청을 거절하면 Anthropic이 권장하는 대체 모델로 같은 호출 안에서 다시 시도합니다.
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { effort: opts.effort },
    messages: [{ role: "user", content: buildUserMessage(opts.input) }],
  });

  let text = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      await opts.onText(event.delta.text);
    }
  }
  const final = await stream.finalMessage();

  const usagePartial = {
    input_tokens: final.usage.input_tokens ?? 0,
    output_tokens: final.usage.output_tokens ?? 0,
    cache_read_tokens: final.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: final.usage.cache_creation_input_tokens ?? 0,
  };
  const servedModel = final.model ?? opts.model;
  const refusalCategory =
    final.stop_reason === "refusal" && final.stop_details && "category" in final.stop_details
      ? String((final.stop_details as { category?: string | null }).category ?? "")
      : null;

  return {
    text,
    stopReason: final.stop_reason ?? null,
    refusalCategory,
    servedModel,
    usage: { ...usagePartial, cost_usd: estimateCost(servedModel, usagePartial) },
  };
}

// 모의 응답: API 키 없이 화면 흐름을 점검할 때 사용 (MOCK_AI=1)
export async function mockStreamChat(opts: Omit<StreamOptions, "apiKey">): Promise<StreamResult> {
  const title = opts.input.prompt.slice(0, 20).replace(/[<>&"]/g, "");
  const colors = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c"];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const text = `모의 응답입니다. "${title}" 요청을 받아 버튼 하나짜리 예시 앱을 만들었습니다. 다음에는 "버튼을 누르면 효과음 대신 색이 바뀌게 해 줘"처럼 수정을 요청해 보세요.

\`\`\`html
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { font-family: sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f8fafc; }
  main { text-align: center; padding: 24px; }
  h1 { color: ${color}; }
  button { font-size: 1.5rem; padding: 16px 32px; border: 0; border-radius: 12px; background: ${color}; color: white; cursor: pointer; }
  #count { font-size: 3rem; margin: 16px 0; }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <div id="count">0</div>
  <button id="btn">눌러 보세요</button>
</main>
<script>
  let n = 0;
  document.getElementById('btn').addEventListener('click', () => {
    n += 1;
    document.getElementById('count').textContent = n;
  });
</script>
</body>
</html>
\`\`\``;

  // 실제 스트리밍처럼 조금씩 내보냅니다.
  for (let i = 0; i < text.length; i += 40) {
    await opts.onText(text.slice(i, i + 40));
    await new Promise((r) => setTimeout(r, 15));
  }
  const usagePartial = { input_tokens: 1800, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0 };
  return {
    text,
    stopReason: "end_turn",
    refusalCategory: null,
    servedModel: "mock",
    usage: { ...usagePartial, cost_usd: estimateCost(opts.model, usagePartial) },
  };
}
