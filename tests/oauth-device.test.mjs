import test from "node:test"
import assert from "node:assert/strict"

import {
  DEVICE_GRANT,
  DEFAULT_MAX_WAIT_MS,
  postForm,
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
} from "../src/oauth-device.mjs"

const DEVICE_URL = "https://vendor.example/oauth/device"
const TOKEN_URL = "https://vendor.example/oauth/token"
const CLIENT_ID = "client-for-test"

function response(status, body) {
  return {
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body)
    },
  }
}

function device(overrides = {}) {
  return {
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    deviceCode: "device-code",
    userCode: "user-code",
    verificationUri: "https://vendor.example/activate",
    verificationUriComplete: "https://vendor.example/activate?code=user-code",
    expiresIn: 60,
    interval: 1,
    ...overrides,
  }
}

function formOf(init) {
  return Object.fromEntries(init.body)
}

test("导出协议常量与默认轮询预算", () => {
  assert.equal(DEVICE_GRANT, "urn:ietf:params:oauth:grant-type:device_code")
  assert.equal(DEFAULT_MAX_WAIT_MS, 180_000)
})

test("requestDeviceCode 使用显式端点并提交 client_id，规范化申请字段", async () => {
  const calls = []
  const dev = await requestDeviceCode({
    deviceAuthUrl: DEVICE_URL,
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    async fetchImpl(url, init) {
      calls.push({ url, init })
      return response(200, {
        device_code: "device-code",
        user_code: "user-code",
        verification_uri: "https://vendor.example/activate",
        verification_uri_complete: "https://vendor.example/activate?code=user-code",
        expires_in: 120,
        interval: 3,
      })
    },
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, DEVICE_URL)
  assert.equal(calls[0].init.method, "POST")
  assert.equal(calls[0].init.headers["content-type"], "application/x-www-form-urlencoded")
  assert.deepEqual(formOf(calls[0].init), { client_id: CLIENT_ID })
  assert.deepEqual(dev, device({ expiresIn: 120, interval: 3 }))
})

test("pollDeviceToken 在 authorization_pending 后继续并返回成功令牌", async () => {
  let clock = 0
  const sleeps = []
  const calls = []
  const replies = [
    response(400, { error: "authorization_pending" }),
    response(200, { access_token: "access", refresh_token: "refresh" }),
  ]

  const token = await pollDeviceToken(device(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return replies.shift()
    },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  })

  assert.equal(token.access_token, "access")
  assert.deepEqual(sleeps, [1000, 1000])
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.url, TOKEN_URL)
    assert.deepEqual(formOf(call.init), {
      grant_type: DEVICE_GRANT,
      device_code: "device-code",
      client_id: CLIENT_ID,
    })
  }
})

test("pollDeviceToken 收到 slow_down 后将后续间隔增加 5 秒", async () => {
  let clock = 0
  const sleeps = []
  const replies = [
    response(400, { error: "slow_down" }),
    response(200, { access_token: "access" }),
  ]

  await pollDeviceToken(device(), {
    fetchImpl: async () => replies.shift(),
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  })

  assert.deepEqual(sleeps, [1000, 6000])
})

test("pollDeviceToken 将 access_denied 报为授权拒绝", async () => {
  let clock = 0
  await assert.rejects(
    pollDeviceToken(device(), {
      fetchImpl: async () => response(400, { error: "access_denied" }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    }),
    (error) => {
      assert.match(error.message, /授权被拒绝/)
      assert.equal(error.signIn, "expired")
      return true
    },
  )
})

test("pollDeviceToken 将 expired_token 报为设备码过期", async () => {
  let clock = 0
  await assert.rejects(
    pollDeviceToken(device(), {
      fetchImpl: async () => response(400, { error: "expired_token" }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    }),
    /设备码已过期/,
  )
})

test("pollDeviceToken 的总等待预算不超过 expires_in，sleep 后到期不再请求", async () => {
  let clock = 0
  const sleeps = []
  let requests = 0

  await assert.rejects(
    pollDeviceToken(device({ expiresIn: 3, interval: 2 }), {
      maxWaitMs: 100_000,
      fetchImpl: async () => {
        requests += 1
        return response(400, { error: "authorization_pending" })
      },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    }),
    /等待授权超时/,
  )

  assert.equal(clock, 3000)
  assert.deepEqual(sleeps, [2000, 1000])
  assert.equal(requests, 1)
})

for (const budget of [
  { name: "maxWaitMs", dev: device({ expiresIn: 60 }), maxWaitMs: 25 },
  { name: "expires_in", dev: device({ expiresIn: 0.025 }), maxWaitMs: 1000 },
]) {
  test(`pollDeviceToken 的 ${budget.name} 会中止永不 resolve 的在飞 fetch`, { timeout: 1000 }, async () => {
    let requests = 0
    const pending = pollDeviceToken(budget.dev, {
      maxWaitMs: budget.maxWaitMs,
      fetchImpl: async (_url, { signal }) => {
        requests += 1
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
      sleep: async () => {},
    })

    await assert.rejects(pending, { name: "TimeoutError" })
    assert.equal(requests, 1)
  })
}

test("pollDeviceToken 在 token fetch 期间可被调用方 AbortSignal 取消", async () => {
  const controller = new AbortController()
  let requestSignal
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const pending = pollDeviceToken(device(), {
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal
      markStarted()
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    },
    sleep: async () => {},
  })

  await started
  assert.notEqual(requestSignal, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: "AbortError" })
})

test("pollDeviceToken 在等待期间可被 AbortSignal 取消", async () => {
  const controller = new AbortController()
  let requests = 0
  const pending = pollDeviceToken(device({ interval: 60 }), {
    signal: controller.signal,
    fetchImpl: async () => {
      requests += 1
      return response(200, { access_token: "unexpected" })
    },
  })
  controller.abort()

  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(requests, 0)
})

test("refreshAccessToken 接受上游轮换后的 refresh_token 并计算过期时间", async () => {
  let request
  const result = await refreshAccessToken({
    refresh: "old-refresh",
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    now: () => 10_000,
    fetchImpl: async (url, init) => {
      request = { url, init }
      return response(200, {
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 60,
      })
    },
  })

  assert.equal(request.url, TOKEN_URL)
  assert.deepEqual(formOf(request.init), {
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
    client_id: CLIENT_ID,
  })
  assert.deepEqual(result, {
    access: "new-access",
    refresh: "new-refresh",
    expires: 70_000,
    clientId: CLIENT_ID,
  })
})

test("refreshAccessToken 在上游未轮换时保留旧 refresh_token", async () => {
  const result = await refreshAccessToken({
    refresh: "old-refresh",
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    now: () => 10_000,
    fetchImpl: async () => response(200, { access_token: "new-access", expires_in: 60 }),
  })

  assert.equal(result.refresh, "old-refresh")
})

for (const code of ["invalid_grant", "expired_token"]) {
  test(`refreshAccessToken 仅在 ${code} 时标记登录失效`, async () => {
    await assert.rejects(
      refreshAccessToken({
        refresh: "old-refresh",
        tokenUrl: TOKEN_URL,
        clientId: CLIENT_ID,
        fetchImpl: async () => response(400, { error: code }),
      }),
      (error) => {
        assert.equal(error.signIn, "expired")
        assert.match(error.message, new RegExp(code))
        return true
      },
    )
  })
}

test("refreshAccessToken 遇到网络错误与 5xx 返回 null 而不误判失效", async () => {
  const options = {
    refresh: "old-refresh",
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
  }

  const network = await refreshAccessToken({
    ...options,
    fetchImpl: async () => {
      throw new Error("offline")
    },
  })
  const server = await refreshAccessToken({
    ...options,
    fetchImpl: async () => response(503, "temporarily unavailable"),
  })

  assert.equal(network, null)
  assert.equal(server, null)
})

test("refreshAccessToken 继续 rethrow 响应读取的 AbortError", async () => {
  const failure = Object.assign(new Error("读取响应时中止"), { name: "AbortError" })
  await assert.rejects(
    refreshAccessToken({
      refresh: "old-refresh",
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      fetchImpl: async () => ({
        status: 200,
        async text() {
          throw failure
        },
      }),
    }),
    (error) => error === failure,
  )
})

test("refreshAccessToken 不把自定义 signal.reason 当普通网络失败", async () => {
  const controller = new AbortController()
  const failure = new Error("用户取消")
  controller.abort(failure)
  await assert.rejects(
    refreshAccessToken({
      refresh: "old-refresh",
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      signal: controller.signal,
      fetchImpl: async () => ({
        status: 200,
        async text() {
          throw failure
        },
      }),
    }),
    (error) => error === failure,
  )
})

test("postForm 保留非 JSON 响应文本且不抛解析错误", async () => {
  const result = await postForm(
    TOKEN_URL,
    { client_id: CLIENT_ID },
    { fetchImpl: async () => response(502, "<html>bad gateway</html>") },
  )

  assert.deepEqual(result, {
    status: 502,
    json: null,
    text: "<html>bad gateway</html>",
  })
})

test("postForm 不吞 response.text() 抛出的 AbortError", async () => {
  const failure = Object.assign(new Error("响应读取已中止"), { name: "AbortError" })
  await assert.rejects(
    postForm(TOKEN_URL, { client_id: CLIENT_ID }, {
      fetchImpl: async () => ({
        status: 200,
        async text() {
          throw failure
        },
      }),
    }),
    (error) => error === failure,
  )
})

test("postForm 不吞 signal 已 abort 时的响应读取错误", async () => {
  const controller = new AbortController()
  controller.abort()
  const failure = new Error("abort 后的读取失败")
  await assert.rejects(
    postForm(TOKEN_URL, { client_id: CLIENT_ID }, {
      signal: controller.signal,
      fetchImpl: async () => ({
        status: 200,
        async text() {
          throw failure
        },
      }),
    }),
    (error) => error === failure,
  )
})

test("postForm 将普通响应读取错误转为空文本", async () => {
  const result = await postForm(TOKEN_URL, { client_id: CLIENT_ID }, {
    fetchImpl: async () => ({
      status: 502,
      async text() {
        throw new Error("响应流损坏")
      },
    }),
  })

  assert.deepEqual(result, { status: 502, json: null, text: "" })
})
