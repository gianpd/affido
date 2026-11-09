import { describe, expect, it } from 'vitest';
import { unansweredMessage } from './chat-failure';
import type { PromptResult } from './types';

const result = (overrides: Partial<PromptResult>): PromptResult => ({
	agent: 'u1',
	status: 'unanswered',
	reason: 'model_error',
	reasonDetail: null,
	answer: null,
	submissionId: 1,
	requestId: null,
	conversationId: 1,
	entries: 0,
	evidence: 'plain',
	evidenceReason: null,
	citations: [],
	citationsMode: 'free',
	runId: null,
	artifacts: [],
	...overrides
});

describe('unansweredMessage', () => {
	it('returns the model answer untouched when there is one', () => {
		expect(unansweredMessage(result({ status: 'done', answer: 'hello' }))).toBe('hello');
	});

	it('names the provider on a timeout instead of blaming the sandbox', () => {
		const message = unansweredMessage(
			result({
				failure: { kind: 'provider_timeout', provider: 'deepseek', reason: 'no_response' }
			})
		);
		expect(message).toContain('the model provider (deepseek)');
		expect(message).toContain('in time');
		expect(message).toContain('The sandbox is running');
	});

	it('explains the transport cause on an unreachable provider', () => {
		const message = unansweredMessage(
			result({
				failure: { kind: 'provider_unreachable', provider: 'openai', reason: 'dns_failure' }
			})
		);
		expect(message).toContain('the model provider (openai)');
		expect(message).toContain('hostname did not resolve');
		expect(message).toContain('AGENT_DNS');
	});

	it('falls back to the raw settlement for unclassified errors', () => {
		const message = unansweredMessage(result({ reasonDetail: '401: Incorrect API key provided' }));
		expect(message).toBe(
			'The agent did not answer: model_error — 401: Incorrect API key provided.'
		);
	});

	it('returns an empty answer as-is, like the old inline expression', () => {
		expect(unansweredMessage(result({ answer: '' }))).toBe('');
	});

	it('keeps the fallback wording when the image predates the failure field', () => {
		expect(unansweredMessage(result({ reason: null }))).toBe(
			'The agent did not answer: unknown reason.'
		);
		expect(unansweredMessage(result({ status: 'done' }))).toBe(
			'The agent finished without a text answer.'
		);
	});
});
