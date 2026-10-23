import { describe, expect, it } from 'vitest';
import { buildDecisionGraph, captureOrdinals, summarizeDecisions, toolsOf } from './trace-graph';
import type { TraceEntry, TraceReport } from './types';

const entry = (id: number, fields: Partial<TraceEntry>): TraceEntry => ({
	id,
	kind: 'pi.user',
	at: 1000 + id,
	summary: `entry ${id}`,
	...fields
});

const report = (...items: TraceEntry[]): TraceReport => ({
	agent: 'faux/faux-1',
	paused: false,
	scheduling: 'idle',
	conversationId: 1,
	entries: { returned: items.length, hasMore: false, items: [...items].reverse() },
	tasks: [],
	submissions: [],
	usage: { input: 0, output: 0, totalTokens: 0, cost: 0 }
});

describe('toolsOf', () => {
	it('reads structured tools and falls back to summary markers', () => {
		expect(toolsOf(entry(1, { tools: ['read', 'bash'] }))).toEqual(['read', 'bash']);
		expect(
			toolsOf(entry(2, { summary: 'listing first tool:list_dir then tool:read_file done' }))
		).toEqual(['list_dir', 'read_file']);
		expect(toolsOf(entry(3, { summary: 'plain reply' }))).toEqual([]);
	});
});

describe('buildDecisionGraph', () => {
	it('connects one turn through prompt, call, ran, observed and answer', () => {
		const trace = report(
			entry(2, { kind: 'pi.user', role: 'user', summary: 'list the files' }),
			entry(3, {
				kind: 'pi.assistant',
				role: 'assistant',
				summary: 'tool:list_dir',
				tools: ['list_dir'],
				stopReason: 'toolUse',
				model: 'faux-1'
			}),
			entry(4, {
				kind: 'pi.tool-result',
				role: 'toolResult',
				summary: 'a.txt b.txt',
				toolName: 'list_dir',
				isError: false,
				durationMs: 9
			}),
			entry(5, {
				kind: 'pi.assistant',
				role: 'assistant',
				summary: 'two files',
				stopReason: 'stop',
				model: 'faux-1'
			})
		);
		const graph = buildDecisionGraph(trace);

		const lane = (key: string) => graph.byKey.get(key)?.lane;
		expect(graph.nodes.map((node) => node.key)).toEqual(['e2', 'e3', 'c3-0', 'e4', 'e5']);
		expect(lane('e2')).toBe('user');
		expect(lane('e3')).toBe('agent');
		expect(lane('c3-0')).toBe('tool');
		expect(lane('e4')).toBe('tool');
		expect(lane('e5')).toBe('agent');

		expect(graph.edges).toEqual([
			{ key: 'e2->e3:prompt', from: 'e2', to: 'e3', verb: 'prompt' },
			{ key: 'e3->c3-0:call', from: 'e3', to: 'c3-0', verb: 'call' },
			{ key: 'c3-0->e4:ran', from: 'c3-0', to: 'e4', verb: 'ran' },
			{ key: 'e4->e5:observed', from: 'e4', to: 'e5', verb: 'observed' }
		]);

		const summary = summarizeDecisions(trace);
		expect(summary.turns).toBe(1);
		expect(summary.decisionTurns).toBe(1);
		expect(summary.calls).toBe(1);
		expect(summary.errors).toBe(0);
		expect(summary.avgCallsPerDecision).toBe(1);
		expect(summary.ranking).toEqual([{ tool: 'list_dir', calls: 1, errors: 0 }]);
	});

	it('marks a failed result and pairs parallel calls in order', () => {
		const graph = buildDecisionGraph(
			report(
				entry(2, { kind: 'pi.user', role: 'user', summary: 'go' }),
				entry(3, {
					kind: 'pi.assistant',
					role: 'assistant',
					summary: 'tool:read tool:write',
					tools: ['read', 'write']
				}),
				entry(4, { kind: 'pi.tool-result', role: 'toolResult', summary: 'ok', toolName: 'read' }),
				entry(5, {
					kind: 'pi.tool-result',
					role: 'toolResult',
					summary: 'boom',
					toolName: 'write',
					isError: true
				}),
				entry(6, {
					kind: 'pi.assistant',
					role: 'assistant',
					summary: 'recovered',
					stopReason: 'stop'
				})
			)
		);

		const verbs = (from: string) =>
			graph.edges.filter((edge) => edge.from === from).map((edge) => edge.verb);
		expect(verbs('e3')).toEqual(['call', 'call']);
		expect(graph.edges).toContainEqual({
			key: 'c3-0->e4:ran',
			from: 'c3-0',
			to: 'e4',
			verb: 'ran'
		});
		expect(graph.edges).toContainEqual({
			key: 'c3-1->e5:failed',
			from: 'c3-1',
			to: 'e5',
			verb: 'failed'
		});
		expect(verbs('e4')).toEqual(['observed']);
		expect(verbs('e5')).toEqual(['observed']);

		// The result of the second call sits under its own call column.
		expect(graph.byKey.get('e5')?.x).toBe(graph.byKey.get('c3-1')?.x);

		// The pairing that powers the params+result panel: each call knows its
		// result entry, each result knows the assistant entry and call position.
		expect(graph.byKey.get('c3-0')).toMatchObject({ entryId: 3, callIndex: 0, resultEntryId: 4 });
		expect(graph.byKey.get('c3-1')).toMatchObject({ entryId: 3, callIndex: 1, resultEntryId: 5 });
		expect(graph.byKey.get('e4')).toMatchObject({ entryId: 4, callEntryId: 3, callIndex: 0 });
		expect(graph.byKey.get('e5')).toMatchObject({ entryId: 5, callEntryId: 3, callIndex: 1 });
	});

	it('falls back to kinds and summary markers for old snapshots', () => {
		const graph = buildDecisionGraph(
			report(
				entry(2, { kind: 'pi.user', summary: 'hi' }),
				entry(3, { kind: 'pi.assistant', summary: 'tool:read_file' }),
				entry(4, { kind: 'pi.tool-result', summary: 'contents' }),
				entry(5, { kind: 'pi.reset', summary: 'reset' }),
				entry(6, { kind: 'pi.user', summary: 'again' })
			)
		);

		expect(graph.byKey.get('e3')?.isDecision).toBe(true);
		expect(graph.byKey.get('c3-0')?.title).toBe('read_file');
		// No structured toolName: the result inherits the pending call's tool.
		expect(graph.byKey.get('e4')?.title).toBe('read_file');
		expect(graph.byKey.get('e5')?.lane).toBe('context');
		// The reset node has no semantic edge, so it rides the backbone.
		expect(graph.edges).toContainEqual({ key: 'e4->e5:next', from: 'e4', to: 'e5', verb: 'next' });
	});
});

describe('captureOrdinals', () => {
	it('numbers captures within each conversation, newest first', () => {
		const ordinals = captureOrdinals([
			{ id: 'c', conversationId: 1 },
			{ id: 'b', conversationId: 2 },
			{ id: 'a', conversationId: 1 }
		]);
		expect(ordinals).toEqual({ c: '1/2', b: '1/1', a: '2/2' });
	});
});
