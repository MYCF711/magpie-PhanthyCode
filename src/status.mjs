// 把上游错误状态翻译成宿主能够正确处理的状态，同时保留请求本身的错误语义

/** 账户余额或配额已经不足 */
const MONEY =
  /(?:积分|点数|余额|额度|配额|钱包)[^。．!！\n]{0,10}(?:不足|用尽|耗尽|不够|已用完|为零|为 ?0)|(?:不足|用尽|耗尽|不够)[^。．!！\n]{0,6}(?:积分|点数|余额|额度)|欠费|请充值|需要充值|充值通道|充值后|insufficient\s+(?:credit|credits|balance|funds?|points?|quota)|(?:credit|credits|balance|funds?|points?|quota)\s+(?:is\s+|are\s+)?(?:insufficient|exhausted|empty|zero|too\s+low)|out\s+of\s+(?:credits?|funds?|points?|balance|quota)|no\s+(?:credits?|balance|quota)(?:\s+(?:left|remaining))?|insufficient_quota|exceeded\s+your\s+current\s+quota/i

/** 上游超时：宿主应按可重试的 504 处理 */
const UPSTREAM_TIMEOUT = /\btimeout\b|\btimed?\s*out\b|超时/i

/** 上游暂时不可用：宿主应退避后重试，而不是当成渠道永久异常 */
const UPSTREAM_UNAVAILABLE =
  /temporarily\s+unavailable|暂时(?:不可用|无法使用)|临时(?:不可用|无法使用)|上游(?:服务)?不可用|服务(?:暂时|临时)?不可用|(?:upstream|service|gateway)(?:\s+is)?\s+(?:temporarily\s+)?unavailable/i

/** 上游渠道自身异常，换用其他渠道可能恢复 */
const CHANNEL_DOWN =
  /bad[_ ]response[_ ]status[_ ]code|bad\s+response\s+status\s+code|no\s+available\s+channels?|无可用渠道|所有渠道|上游(?:服务)?(?:错误|异常|失败)|网关(?:错误|异常)|upstream\s+(?:error|failure)/i

/** 模型未提供服务，不应误判为整个账户登录失效 */
const MODEL_UNSERVED =
  /(?:模型|该模型|此模型)[^。．!！\n]{0,60}(?:不存在|不支持|不可用|无权|未开通|未授权|已下线|已停用)|无权(?:访问|使用)(?:该|此)?模型|(?:no such|unknown|invalid|unsupported)\s+model|model[^。\n]{0,80}(?:not\s+(?:supported|accessible|available|found|enabled|allowed|permitted|exist)|does\s?n[o']?t\s+exist)|model_not_found|not\s+(?:authorized|permitted)\s+to\s+(?:use|access)\s+(?:this\s+)?model/i

/** 只有明确指出频率或请求数限制时才判定为限流 */
const RATE_LIMIT = /每分钟|每秒|一分钟内|频率限制|请求(?:数|频率)限制|rate.?limit|too many requests|per\s+(?:second|sec|minute|min)\b|\b[rt]p[ms]\b|throttl/i

/** 请求过长需要压缩输入，换渠道无法解决 */
const TOO_LONG =
  /max_tokens|max_output_tokens|max_completion_tokens|context[_ ](?:length|window|limit)|prompt\s+is\s+too\s+long|input\s+is\s+too\s+long|maximum\s+context|too\s+many\s+(?:input\s+|prompt\s+)?tokens|token\s+limit\s+exceeded|reduce\s+the\s+length\s+of\s+the\s+messages|上下文(?:长度)?(?:超|过长)|超(?:过|出)(?:了)?(?:模型)?(?:的)?(?:最大)?上下文/i

/** 这条错误文案是不是账户余额或配额不足 */
export function isMoneyRefusal(text) {
  return MONEY.test(String(text ?? ""))
}

/** 这条错误文案是不是上游超时 */
export function isUpstreamTimeout(text) {
  return UPSTREAM_TIMEOUT.test(String(text ?? ""))
}

/** 这条错误文案是不是上游暂时不可用 */
export function isUpstreamUnavailable(text) {
  return UPSTREAM_UNAVAILABLE.test(String(text ?? ""))
}

/** 这条错误文案是不是上游渠道自身异常 */
export function isChannelDown(text) {
  return CHANNEL_DOWN.test(String(text ?? ""))
}

/** 这条错误文案是不是模型未提供服务 */
export function isModelUnserved(text) {
  return MODEL_UNSERVED.test(String(text ?? ""))
}

/**
 * 把上游状态与错误文案映射为目标状态；返回 0 表示保持原响应。
 * 只有 400/422 需要分类，其余状态不应读取响应体。
 */
export function classifyRefusal(status, text) {
  if (status !== 400 && status !== 422) return 0
  const t = String(text ?? "")
  if (!t) return 0

  // 顺序即优先级：请求过长先放行，余额其次，再区分超时、暂不可用、渠道、模型和限流
  if (TOO_LONG.test(t)) return 0
  if (MONEY.test(t)) return 402
  if (UPSTREAM_TIMEOUT.test(t)) return 504
  if (UPSTREAM_UNAVAILABLE.test(t)) return 503
  if (CHANNEL_DOWN.test(t)) return 502
  if (MODEL_UNSERVED.test(t)) return 404
  if (RATE_LIMIT.test(t)) return 429
  return 0
}

/**
 * 把非 JSON 响应体压缩成一句可展示的摘要。
 * HTML 只保留标题与状态，普通文本最多保留前 200 个字符。
 */
export function upstreamText(text, status) {
  const t = String(text ?? "").trim()
  if (!t) return ""
  if (t.startsWith("<")) {
    const title = (t.match(/<title[^>]*>([^<]{0,80})<\/title>/i)?.[1] || "").trim()
    const shown = title && title !== String(status) ? `（${title}）` : ""
    return `上游返回 HTML 错误页${shown}，不是接口响应（HTTP ${status}）`
  }
  return t.slice(0, 200)
}

const REASON = {
  402: "Payment Required",
  404: "Not Found",
  429: "Too Many Requests",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

/**
 * 只改写 400/422 中能够明确分类的错误。
 * 非 400/422 直接返回同一对象；400/422 也只读取 clone，原响应始终可读。
 */
export async function rewriteRefusal(res) {
  const status = res?.status
  if (status !== 400 && status !== 422) return res

  let text
  try {
    text = await res.clone().text()
  } catch {
    return res
  }

  const mapped = classifyRefusal(status, text)
  if (!mapped) return res

  const headers = new Headers(res.headers)
  // 新响应体已经不同于原响应，旧的长度与编码声明不再成立
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("x-magpie-vendor-status", String(status))

  return new Response(text, {
    status: mapped,
    statusText: REASON[mapped] ?? "",
    headers,
  })
}
