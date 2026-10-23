import { describe, expect, it } from 'vitest';
import { renderCitationRefs, renderMarkdown } from './markdown';

describe('renderCitationRefs', () => {
	it('numbers tokens by the order of the citations list', () => {
		const html = '<p>Renews on 1 March [cit_aaaa000001].</p>';
		expect(renderCitationRefs(html, ['cit_aaaa000001'])).toBe(
			'<p>Renews on 1 March <sup class="citation-ref"><a href="#cite-cit_aaaa000001" data-citation="cit_aaaa000001" aria-label="Citation 1">1</a></sup>.</p>'
		);
	});

	it('numbers a grouped token with its own index', () => {
		const html = '<p>[cit_aaaa000001; cit_bbbb000002]</p>';
		expect(renderCitationRefs(html, ['cit_aaaa000001', 'cit_bbbb000002'])).toBe(
			'<p><sup class="citation-ref"><a href="#cite-cit_aaaa000001" data-citation="cit_aaaa000001" aria-label="Citation 1">1</a></sup> <sup class="citation-ref"><a href="#cite-cit_bbbb000002" data-citation="cit_bbbb000002" aria-label="Citation 2">2</a></sup></p>'
		);
	});

	it('leaves a token without a citation unnumbered', () => {
		const html = '<p>[cit_ffffffffff]</p>';
		expect(renderCitationRefs(html, ['cit_aaaa000001'])).toBe('<p>[cit_ffffffffff]</p>');
	});

	it('does not touch ordinary brackets', () => {
		const html = '<p>[see attached]</p>';
		expect(renderCitationRefs(html, [])).toBe(html);
	});
});

describe('renderMarkdown with citations', () => {
	it('renders heading and line with the reference', () => {
		const out = renderMarkdown('## Renewal\n\nIt renews [cit_aaaa000001].', {
			citations: ['cit_aaaa000001']
		});
		expect(out).toContain('citation-ref');
		expect(out).toContain('data-citation="cit_aaaa000001"');
		expect(out.includes('Renews')).toBe(false);
	});
});
