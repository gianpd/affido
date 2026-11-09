// Classify an `unanswered` settlement into the provider failure the UI can
// explain. The sidecar (RFC 0013 §6.1) is the only process that talks to the
// provider, so its error body is the one place where "the provider did not
// answer" is known to be the cause: pi-ai renders that body into the
// settlement detail as `<status>: {"error":…}`. Everything else — bad key,
// quota, context overflow — stays `model_error` with the raw detail.

import type { PromptFailure } from "./types.ts";

/** The sidecar's body is `{"error":…,"reason":…,"message":…}`; the regex
 * tolerates a `message` between the two fields and any whitespace, because
 * pi-ai may prefix the detail with the HTTP status. */
const SIDECAR_FAILURE = /"error"\s*:\s*"(upstream_timeout|upstream_unreachable)"(?:[^}]*?"reason"\s*:\s*"([a-z_]+)")?/;

/** Null unless the detail is one of the sidecar's two upstream-failure codes.
 * `provider` is the run's configured provider, reported for the message. */
export const classifyProviderFailure = (detail: string | null, provider: string): PromptFailure | null => {
	if (detail === null) return null;
	const match = SIDECAR_FAILURE.exec(detail);
	if (match === null) return null;
	const [, code, reason] = match;
	return {
		kind: code === "upstream_timeout" ? "provider_timeout" : "provider_unreachable",
		provider,
		reason: reason ?? null,
	};
};
