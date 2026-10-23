/**
 * Chat answer chunking: the sandbox answers in one shot, so the stream emits
 * the text in small deltas and the UI paints progressively instead of waiting
 * for a single large chunk. Pure string work, safe for client and server.
 */
export function* chunkText(text: string, size = 48): Generator<string> {
	for (let index = 0; index < text.length; index += size) {
		yield text.slice(index, index + size);
	}
}
