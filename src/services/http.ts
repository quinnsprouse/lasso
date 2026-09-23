import { Cause } from "effect"
import type { HttpClientError } from "effect/unstable/http"
import type { AppError } from "../errors.ts"
import { Errors, messageOf } from "../errors.ts"
import { ENVIRONMENT } from "../settings.ts"

/**
 * An HTTP failure as a catalog error, so `transient` tells an agent the truth:
 * exactly the failures `HttpClient.retryTransient` retries (a timeout, the
 * network, 408, 429, 5xx) are transient; a bad token or a missing resource is
 * not. `resource` names what was requested; `token` names the variable that
 * holds its credential.
 */
export const httpFailure =
  (resource: string, token: { readonly name: string }) =>
  (error: HttpClientError.HttpClientError | Cause.TimeoutError): AppError => {
    if (Cause.isTimeoutError(error)) {
      return Errors.transientFailure({
        message: `${resource} did not answer in time`,
        fix: `retry; if it keeps timing out, raise ${ENVIRONMENT.httpTimeout.name}`,
      })
    }
    const { reason } = error
    if (reason._tag !== "StatusCodeError") {
      return reason._tag === "TransportError"
        ? Errors.serviceUnavailable({
            message: `cannot reach ${resource}: ${messageOf(reason.cause ?? reason)}`,
            fix: "check the host and your network, then retry",
          })
        : Errors.invalidData({
            message: `${resource} sent a response that could not be read: ${reason.message}`,
            fix: "check that the URL serves the expected JSON",
          })
    }
    const status = reason.response.status
    if (status === 401 || status === 403) {
      return Errors.authFailure({
        message: `${resource} refused the request (HTTP ${status})`,
        fix: `set ${token.name} to a token that ${resource} accepts`,
      })
    }
    if (status === 404 || status === 410) {
      return Errors.notFound({
        message: `${resource} does not exist (HTTP ${status})`,
        fix: "check the URL",
      })
    }
    if (status === 408 || status === 429) {
      return Errors.transientFailure({
        message: `${resource} asked to retry later (HTTP ${status})`,
        fix: "wait, then retry",
      })
    }
    if (status >= 500) {
      return Errors.serviceUnavailable({
        message: `${resource} failed (HTTP ${status})`,
        fix: "retry later; the server is failing, not the request",
      })
    }
    return Errors.invalidUsage({
      message: `${resource} rejected the request (HTTP ${status})`,
      fix: "check the URL and its query parameters",
    })
  }
