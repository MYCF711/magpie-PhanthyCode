// src/chat.mjs —— 对话转发：流式、usage、以及三个「不报错但结果错」的坑
//
// 这个文件在四个真实插件里都有（chat.mjs / chat-task.mjs）。它存在的理由：
// magpie 的 provider 路径**永远要求流式响应**，而各家上游的「流」千奇百怪。

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // 关掉缓冲：少了它会攒够一整块才吐，界面像卡住
  "x-accel-buffering": "no",
}

/**
 * ⚠ 坑 ①：**不要在插件里把流读干**。
 *
 * 把上游的 `Response` 原样 return 出去是最安全的 —— magpie 会自己做背压和分帧。
 * 一旦你在插件里 `await res.text()` 再包成 SSE，就变成「假流式」：
 * 首字延迟 = 总耗时，长回答的用户体验直接崩。
 */
export function passThrough(res, extraHeaders = {}) {
  return new Response(res.body, {
    status: res.status,
    headers: { ...SSE_HEADERS, ...extraHeaders },
  })
}

/**
 * ⚠ 坑 ②：**流式请求必须带 `stream_options: { include_usage: true }`**（OpenAI 兼容的上游）。
 *
 * 不带的话上游不回 usage ⇒ magpie 的额度条永远是 0、`usage` 钩子拿不到扣了多少。
 * 这个坑的表现是「一切正常，只是数字不动」，能藏好几天。
 */
export function withUsage(body) {
  if (!body || typeof body !== "object") return body
  if (body.stream === false) return body
  return { ...body, stream: true, stream_options: { ...(body.stream_options || {}), include_usage: true } }
}

/**
 * ⚠ 坑 ③：**magpie 不看你的 `stream:false`**。
 *
 * provider 路径下即使客户端要非流式，magpie 也会说「did not stream」。
 * 所以插件只有一条路：把它变成 SSE。上游本来就是流 → `passThrough`；
 * 上游一次性给全 → `singleShotToSSE` 包成一帧一帧。
 */

/** 把一段完整的回复包成最小可用的 SSE 流（上游不增量时用） */
export function singleShotToSSE({ id = "chatcmpl-1", model = "", text = "", usage = null }) {
  const enc = new TextEncoder()
  const chunk = (delta, finish = null, extra = {}) =>
    enc.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      })}\n\n`,
    )

  const parts = [chunk({ role: "assistant" }), chunk({ content: text }), chunk({}, "stop")]
  if (usage) parts.push(enc.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage })}\n\n`))
  parts.push(enc.encode("data: [DONE]\n\n"))

  return new Response(
    new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(p)
        controller.close()
      },
    }),
    { headers: SSE_HEADERS },
  )
}

/**
 * 流式不能用一刀切的 AbortSignal.timeout —— 长回答会被中途砍断。
 * 用「空闲超时」：多久没有新字节才算挂。
 */
export function idleTimeout(ms, onTimeout) {
  let timer = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        onTimeout?.()
      } catch {}
    }, ms)
  }
  arm()
  return {
    touch: arm,
    clear: () => timer && clearTimeout(timer),
  }
}

/**
 * usage 归一化：上游给的字段名五花八门，但 magpie 只认这三个。
 * 注意 `cached` 各家口径不同（有的算进 prompt，有的单列）—— 拿不准就别填。
 */
export function normalizeUsage(u) {
  if (!u) return null
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0)
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0)
  const total = Number(u.total_tokens ?? prompt + completion)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null
  return { prompt, completion, total: Number.isFinite(total) ? total : prompt + completion }
}
