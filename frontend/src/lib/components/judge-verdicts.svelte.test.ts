import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import JudgeVerdicts from './judge-verdicts.svelte';
import type { CitationRunJudge } from '#lib/types';

/**
 * RFC 0020 §6 V8: the judge tab renders the attempt structure — the published
 * attempt selected by default, one row per attempt with its outcome, named
 * error causes, and the probability/margin columns. The fixture is the same
 * redacted shape as the motivating run (conversation 1487): four judge
 * attempts numbered 2..5, the shipped one carrying 22 pairs of which 18
 * supported, and attempt 3 a single timeout that answered nothing.
 */

const pairs = (count: number, startLine = 3): CitationRunJudge['verdicts'] =>
	Array.from({ length: count }, (_, index) => ({
		line: startLine + Math.floor(index / 3),
		citationId: `cit_${`${index}`.padStart(10, '0')}`,
		verdict: index % 5 === 4 ? 'unsupported' : 'supported',
		score: index === 12 ? 0.24 : 0.5 + (index % 4) * 0.1,
		ms: index === 12 ? 1320 : 200 + index,
		truncated: index % 6 === 3,
		probabilities:
			index % 2 === 0
				? { supported: 0.6 + (index % 3) * 0.05, unrelated: 0.2, contradicted: 0.1 }
				: undefined,
		margin: index % 5 === 4 ? -0.3 : 0.4
	}));

const fixture: CitationRunJudge = {
	mode: 'enforce',
	attempts: [
		{
			attempt: 2,
			at: 0,
			lines: 2,
			pairs: 2,
			supported: 1,
			unsupported: 1,
			contradicted: 0,
			errors: 1,
			errorCauses: { timeout: 1 },
			truncated: 0,
			outcome: 'judge_error_unverified',
			legacy: false,
			latencyMs: { p50: 278, p95: 351, max: 351 }
		},
		{
			attempt: 3,
			at: 0,
			lines: 1,
			pairs: 0,
			supported: 0,
			unsupported: 0,
			contradicted: 0,
			errors: 1,
			errorCauses: { timeout: 1 },
			truncated: 0,
			outcome: 'judge_error_unverified',
			legacy: false,
			latencyMs: null
		},
		{
			attempt: 4,
			at: 0,
			lines: 7,
			pairs: 23,
			supported: 17,
			unsupported: 6,
			contradicted: 0,
			errors: 0,
			errorCauses: {},
			truncated: 4,
			outcome: 'incoherent_citation',
			legacy: false,
			latencyMs: { p50: 226, p95: 351, max: 606 }
		},
		{
			attempt: 5,
			at: 0,
			lines: 6,
			pairs: 22,
			supported: 18,
			unsupported: 4,
			contradicted: 0,
			errors: 0,
			errorCauses: {},
			truncated: 4,
			outcome: 'published',
			legacy: false,
			latencyMs: { p50: 228, p95: 606, max: 1320 }
		}
	],
	published: {
		attempt: 5,
		at: 0,
		lines: 6,
		pairs: 22,
		supported: 18,
		unsupported: 4,
		contradicted: 0,
		errors: 0,
		errorCauses: {},
		truncated: 4,
		outcome: 'published',
		legacy: false,
		latencyMs: { p50: 228, p95: 606, max: 1320 }
	},
	verdicts: pairs(22),
	judgeVerdicts: 22,
	judgeRejections: 3,
	judgeTruncated: 4,
	judgeErrors: 0,
	supported: 18,
	unsupported: 4,
	contradicted: 0,
	latencyMs: { p50: 228, p95: 606, max: 1320 }
};

test('renders the published attempt with its selector, attempts, causes and probabilities', async () => {
	const screen = render(JudgeVerdicts, { props: { judge: fixture } });

	// Header: the published attempt, its counts, the latency envelope.
	await expect.element(screen.getByText('attempt 5 of 5 · published')).toBeInTheDocument();
	await expect.element(screen.getByText('18 supported').first()).toBeInTheDocument();
	await expect.element(screen.getByText('4 unsupported').first()).toBeInTheDocument();
	await expect.element(screen.getByText('4 truncated').first()).toBeInTheDocument();
	await expect.element(screen.getByText(/max\s*1320 ms/)).toBeInTheDocument();

	// One row per attempt, with its outcome; the merged error causes are visible.
	await expect.element(screen.getByText('#2')).toBeInTheDocument();
	const attempt3 = screen.getByText('#3');
	await expect.element(attempt3).toBeInTheDocument();
	await expect.element(screen.getByText(/2× timeout/)).toBeInTheDocument();
	await expect.element(screen.getByText('#4')).toBeInTheDocument();
	await expect.element(screen.getByText('#5')).toBeInTheDocument();
	await expect.element(screen.getByText('3 rejected')).toBeInTheDocument();

	// The published table shows the probability and margin columns.
	await expect.element(screen.getByText('P(sup)')).toBeInTheDocument();
	await expect.element(screen.getByText('0.24')).toBeInTheDocument();

	// Selecting attempt 3 switches to its summary: answered nothing, names its timeout.
	await attempt3.click();
	await expect.element(screen.getByText(/Attempt #3 answered 0 pairs/)).toBeInTheDocument();
	await expect.element(screen.getByText(/1 error: 1× timeout/)).toBeInTheDocument();
});

test('a null judge explains that the layer did not run', async () => {
	const screen = render(JudgeVerdicts, { props: { judge: null } });
	await expect.element(screen.getByText(/did not run for this citation run/)).toBeInTheDocument();
});

test('a legacy trace reads as one attempt', async () => {
	const legacy: CitationRunJudge = {
		mode: 'enforce',
		attempts: [
			{
				attempt: 1,
				at: 0,
				lines: 0,
				pairs: 47,
				supported: 36,
				unsupported: 11,
				contradicted: 0,
				errors: 2,
				errorCauses: {},
				truncated: 8,
				outcome: 'published',
				legacy: true,
				latencyMs: { p50: 221, p95: 351, max: 1320 }
			}
		],
		published: null,
		verdicts: pairs(3),
		judgeVerdicts: 47,
		judgeRejections: 3,
		judgeTruncated: 8,
		judgeErrors: 2,
		supported: 36,
		unsupported: 11,
		contradicted: 0,
		latencyMs: { p50: 221, p95: 351, max: 1320 }
	};
	const screen = render(JudgeVerdicts, { props: { judge: legacy } });
	await expect.element(screen.getByText('attempt 1 of 1 · published')).toBeInTheDocument();
	await expect.element(screen.getByText('legacy trace')).toBeInTheDocument();
});
