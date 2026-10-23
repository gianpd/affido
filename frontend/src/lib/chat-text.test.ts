import { describe, expect, it } from 'vitest';
import { chunkText } from './chat-text';

describe('chunkText', () => {
	it('reassembles to the original text', () => {
		const text = 'x'.repeat(200);
		const chunks = [...chunkText(text)];
		expect(chunks.join('')).toBe(text);
	});

	it('splits into fixed-size windows and a shorter tail', () => {
		expect([...chunkText('abcdefgh', 3)]).toEqual(['abc', 'def', 'gh']);
	});

	it('yields nothing for empty text', () => {
		expect([...chunkText('')]).toEqual([]);
	});
});
