import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/unstable/http"
import { TaskFeed } from "../../src/services/feed.ts"

/**
 * The API-client pattern through a fake HttpClient and an explicit
 * ConfigProvider: no network, no process environment. `it.live` because the
 * retry backoff sleeps on the real clock.
 */

const FEED = new URL("https://feed.test/tasks.json")

type Reply = Response | "network down" | "hang"

/** Headers now, then a body that never finishes: fetch has resolved, the exchange has not. */
const stalledBody = () =>
  new Response(new ReadableStream({ start: () => {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const serving = (reply: (request: HttpClientRequest.HttpClientRequest) => Reply) => {
  const seen: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) => {
    seen.push(request)
    const answer = reply(request)
    if (answer === "hang") return Effect.never
    if (answer === "network down") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNREFUSED") }),
        }),
      )
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer))
  })
  return { seen, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const titles = (
  http: { layer: Layer.Layer<HttpClient.HttpClient> },
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    return yield* (yield* TaskFeed).titles(FEED)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TaskFeed.layer.pipe(Layer.provide(http.layer)),
        ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
      ),
    ),
  )

describe("TaskFeed", () => {
  it.live("reads the titles a feed lists", () =>
    Effect.gen(function* () {
      const http = serving(() => json({ tasks: [{ title: "Ship" }, { title: "Docs" }] }))
      expect(yield* titles(http)).toEqual(["Ship", "Docs"])
    }),
  )

  it.live("sends the token as a bearer header only when LASSO_FEED_TOKEN is set", () =>
    Effect.gen(function* () {
      const http = serving(() => json({ tasks: [] }))
      yield* titles(http)
      yield* titles(http, { LASSO_FEED_TOKEN: "s3cret" })
      expect(http.seen.map((request) => request.headers["authorization"])).toEqual([
        undefined,
        "Bearer s3cret",
      ])
    }),
  )

  it.live.each([
    [401, "auth_failure", false, 1],
    [404, "not_found", false, 1],
    [400, "invalid_usage", false, 1],
    [429, "transient_failure", true, 3],
    [503, "service_unavailable", true, 3],
  ] as const)(
    "HTTP %i fails as %s (transient: %s) after %i attempt(s)",
    ([status, code, transient, attempts]) =>
      Effect.gen(function* () {
        const http = serving(() => json({ error: "no" }, status))
        const error = yield* Effect.flip(titles(http))
        expect(error.code).toBe(code)
        expect(error.transient).toBe(transient)
        expect(http.seen.length).toBe(attempts)
      }),
  )

  it.live("an unreachable host is service_unavailable, retried like any transient failure", () =>
    Effect.gen(function* () {
      const http = serving(() => "network down")
      const error = yield* Effect.flip(titles(http))
      expect(error.code).toBe("service_unavailable")
      expect(http.seen.length).toBe(3)
    }),
  )

  it.live("a body that is not a feed is invalid_data", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(titles(serving(() => json({ items: [] }))))
      expect(error.code).toBe("invalid_data")
    }),
  )

  it.live("LASSO_HTTP_TIMEOUT bounds the call; running out is transient", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        titles(
          serving(() => "hang"),
          { LASSO_HTTP_TIMEOUT: "50 millis" },
        ),
      )
      expect(error.code).toBe("transient_failure")
      expect(error.fix).toContain("LASSO_HTTP_TIMEOUT")
    }),
  )

  it.live("the timeout covers the body too, not only the headers", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        titles(serving(stalledBody), { LASSO_HTTP_TIMEOUT: "50 millis" }),
      )
      expect(error.code).toBe("transient_failure")
    }),
  )

  it.live("a malformed setting fails this command as invalid_config, naming the variable", () =>
    Effect.gen(function* () {
      const http = serving(() => json({ tasks: [] }))
      const error = yield* Effect.flip(titles(http, { LASSO_HTTP_TIMEOUT: "soon" }))
      expect(error.code).toBe("invalid_config")
      expect(error.fix).toContain("LASSO_HTTP_TIMEOUT")
      expect(http.seen.length).toBe(0)
    }),
  )
})
