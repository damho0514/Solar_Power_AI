// 무료 LLM에 프롬프트를 보내고 본문 텍스트만 스트리밍으로 돌려준다. 서버에서만 쓴다.
// GEMINI_API_KEY가 있으면 Google Gemini 무료 API(배포 서버용), 없으면 로컬 Ollama(노트북용)를 쓴다.

const GEMINI_KEY = (process.env.GEMINI_API_KEY ?? "").trim(); // 붙여 넣을 때 섞인 줄바꿈·공백 제거
// "-latest" 별칭은 Google이 최신 Flash 모델로 바꿔 가리키므로 모델이 은퇴해도 코드를 고칠 필요가 없다
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
// 무료 API는 사용량이 몰리면 503·429를 돌려준다. 그때는 가벼운 모델로 한 번 더 시도한다.
const GEMINI_FALLBACK = process.env.GEMINI_FALLBACK_MODEL ?? "gemini-flash-lite-latest";
const RETRYABLE = new Set([404, 429, 500, 503]);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "gemma3:4b";

export const PROVIDER = GEMINI_KEY ? "gemini" : "ollama";
export const MODEL = GEMINI_KEY ? GEMINI_MODEL : OLLAMA_MODEL;

type Options = { temperature?: number; num_ctx?: number };

// 배포 서버(Vercel)에는 Ollama가 없다. 키가 없으면 localhost로 헛되이 연결하지 않고 바로 원인을 알려 준다.
const ON_SERVER = !!process.env.VERCEL;

export function llmStatus() {
  return { provider: PROVIDER, model: MODEL, geminiKey: GEMINI_KEY !== "", hosted: ON_SERVER };
}

export function streamChat(prompt: string, options: Options = {}): Promise<Response> {
  if (GEMINI_KEY) return streamGemini(prompt, options);
  if (ON_SERVER)
    return Promise.resolve(
      new Response("배포 서버에 AI 키(GEMINI_API_KEY)가 설정되지 않았어요. Vercel 프로젝트 환경변수에 키를 넣고 다시 배포하세요.", { status: 503 }),
    );
  return streamOllama(prompt, options);
}

const headers = { "Content-Type": "text/plain; charset=utf-8", "X-Model": MODEL, "X-Provider": PROVIDER };

// 줄 단위로 들어오는 스트림에서 한 줄씩 본문 텍스트를 뽑아 흘려보낸다
function textStream(body: ReadableStream<Uint8Array>, pick: (line: string) => string | undefined) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const text = pick(line);
          if (text) controller.enqueue(encoder.encode(text));
        }
      },
    }),
  );
}

async function streamGemini(prompt: string, options: Options): Promise<Response> {
  let upstream: Response | null = null;
  let model = GEMINI_MODEL;
  for (const m of [GEMINI_MODEL, GEMINI_FALLBACK]) {
    model = m;
    try {
      upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: options.temperature ?? 0.3 },
        }),
      });
    } catch {
      upstream = null;
      continue;
    }
    if (upstream.ok || !RETRYABLE.has(upstream.status)) break;
  }
  if (!upstream) return new Response("Gemini API에 연결할 수 없습니다.", { status: 503 });
  if (!upstream.ok || !upstream.body) {
    const msg = await upstream.text();
    const hint = RETRYABLE.has(upstream.status) ? "\n무료 API 사용량이 몰렸거나 한도를 넘었습니다. 잠시 뒤 다시 시도하세요." : "";
    return new Response(`Gemini 오류 (${upstream.status}): ${msg}${hint}`, { status: 502 });
  }

  // SSE: "data: {...}" 줄마다 candidates[0].content.parts[].text
  const stream = textStream(upstream.body, (line) => {
    if (!line.startsWith("data:")) return;
    const json = JSON.parse(line.slice(5)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  });
  return new Response(stream, { headers: { ...headers, "X-Model": model } });
}

async function streamOllama(prompt: string, options: Options): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: true,
        messages: [{ role: "user", content: prompt }],
        options: { temperature: 0.3, ...options },
      }),
    });
  } catch {
    return new Response(`Ollama(${OLLAMA_URL})에 연결할 수 없습니다. 터미널에서 'ollama serve'를 실행했는지 확인하세요.`, {
      status: 503,
    });
  }

  if (!upstream.ok || !upstream.body) {
    const msg = await upstream.text();
    return new Response(`Ollama 오류: ${msg}\n모델이 없다면 'ollama pull ${OLLAMA_MODEL}'을 실행하세요.`, { status: 502 });
  }

  // Ollama는 줄 단위 JSON(NDJSON)을 보낸다
  const stream = textStream(upstream.body, (line) => (JSON.parse(line) as { message?: { content?: string } }).message?.content);
  return new Response(stream, { headers });
}
