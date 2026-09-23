import { Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { AppError } from "../errors.ts"
import { Errors } from "../errors.ts"
import { ENVIRONMENT, feedToken, httpTimeout } from "../settings.ts"
import { httpFailure } from "./http.ts"

/** A task feed: JSON of the form `{ "tasks": [{ "title": "…" }] }`. */
const Feed = Schema.Struct({
  tasks: Schema.Array(Schema.Struct({ title: Schema.String })),
})

export interface TaskFeedApi {
  /** The titles a feed lists, or a catalog error chosen from how the request failed. */
  readonly titles: (url: URL) => Effect.Effect<ReadonlyArray<string>, AppError>
}

/**
 * The demo's remote read: the pattern for any service that calls an API. The
 * client's middleware (JSON, status check, retries) is set up once; each call
 * reads its settings, bounds the whole exchange by a timeout, decodes the body
 * with a schema, and maps every failure to the catalog.
 */
export class TaskFeed extends Context.Service<TaskFeed, TaskFeedApi>()("lasso/services/TaskFeed") {
  static readonly layer: Layer.Layer<TaskFeed, never, HttpClient.HttpClient> = Layer.effect(
    TaskFeed,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
        HttpClient.filterStatusOk,
        // Retries exactly the transient failures (network, 408, 429, 5xx) with backoff.
        HttpClient.retryTransient({
          schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
          times: 2,
        }),
      )

      const titles = Effect.fn("TaskFeed.titles")(function* (url: URL) {
        const token = yield* feedToken
        const timeout = yield* httpTimeout
        const request = Option.match(token, {
          onNone: () => HttpClientRequest.get(url),
          onSome: (secret) =>
            HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(secret)),
        })
        // One timeout for the whole exchange: fetch resolves once headers
        // arrive, so a stalled body must count against the same limit.
        const feed = yield* client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Feed)),
          Effect.timeout(timeout),
          Effect.mapError((error) =>
            Schema.isSchemaError(error)
              ? Errors.invalidData({
                  message: `${url.href} is not a task feed: ${error.message}`,
                  fix: 'point at JSON of the form {"tasks":[{"title":"…"}]}',
                })
              : httpFailure(url.host, ENVIRONMENT.feedToken)(error),
          ),
        )
        return feed.tasks.map((task) => task.title)
      })

      return TaskFeed.of({ titles })
    }),
  )
}
