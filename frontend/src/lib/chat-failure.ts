import type { PromptFailure, PromptResult } from './types';

/** The sidecar's transport classification, turned into one clause each. The
 * keys are the `reason` values of RFC 0013 §6.1's error body. */
const UNREACHABLE_DETAIL: Record<string, string> = {
	dns_failure:
		"the provider's hostname did not resolve. Check AGENT_EGRESS and the AGENT_DNS resolver.",
	connect_timeout:
		'the connection timed out. Check that AGENT_EGRESS is open and the provider endpoint is reachable.',
	connect_failure:
		'the connection failed. Check that AGENT_EGRESS is open and the provider endpoint is reachable.',
	tls_failure: 'the TLS handshake failed. Check the provider endpoint and any egress proxy.'
};

const providerFailureMessage = (failure: PromptFailure): string => {
	const provider = `the model provider (${failure.provider})`;
	if (failure.kind === 'provider_timeout') {
		return `The sandbox could not get an answer from ${provider} in time. The sandbox is running; the provider may be slow or down.`;
	}
	const detail =
		failure.reason === null
			? 'the network call failed.'
			: (UNREACHABLE_DETAIL[failure.reason] ?? 'the network call failed.');
	return `The sandbox could not reach ${provider}: ${detail}`;
};

/**
 * The assistant text for one `/prompt` result.
 *
 * A dead sandbox never reaches this function: the fetch throws and the route
 * reports a `SandboxError`. Here the sandbox answered, so a missing answer
 * means either the provider failed (classified by the sidecar) or the run
 * failed for another reason (bad key, quota, context overflow), which keeps
 * the raw settlement detail.
 */
export const unansweredMessage = (result: PromptResult): string => {
	if (result.answer !== null) return result.answer;
	if (result.failure) return providerFailureMessage(result.failure);
	if (result.status === 'unanswered') {
		return `The agent did not answer: ${result.reason ?? 'unknown reason'}${result.reasonDetail ? ` — ${result.reasonDetail}` : ''}.`;
	}
	return 'The agent finished without a text answer.';
};
