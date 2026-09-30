// 로컬 Ollama(무료 LLM)에 프롬프트를 보내고 본문 텍스트만 스트리밍으로 돌려준다. 서버에서만 쓴다.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const MODEL = process.env.OLLAMA_MODEL ?? "gemma3:4b";

export async function streamChat(prompt: string, options: Record<string, number> = {}): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
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
    return new Response(`Ollama 오류: ${msg}\n모델이 없다면 'ollama pull ${MODEL}'을 실행하세요.`, { status: 502 });
  }

  // Ollama는 줄 단위 JSON(NDJSON)을 보낸다. 본문 텍스트만 뽑아서 그대로 흘려보낸다.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  const stream = upstream.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const json = JSON.parse(line) as { message?: { content?: string } };
          const text = json.message?.content;
          if (text) controller.enqueue(encoder.encode(text));
        }
      },
    }),
  );

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Model": MODEL },
  });
}
