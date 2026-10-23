import { describe, expect, it } from 'vitest';
import { placeTooltip } from './citation-tooltip';

describe('placeTooltip', () => {
	it('places the card above the anchor, centered on it', () => {
		const placement = placeTooltip(
			{ top: 300, bottom: 320, centerX: 400 },
			{ width: 200, height: 100 },
			{ width: 1280, height: 800 }
		);
		expect(placement).toEqual({ top: 300 - 100 - 6, left: 400 - 100 });
	});

	it('flips below the anchor when there is no room above', () => {
		const placement = placeTooltip(
			{ top: 40, bottom: 60, centerX: 400 },
			{ width: 200, height: 100 },
			{ width: 1280, height: 800 }
		);
		expect(placement.top).toBe(60 + 6);
	});

	it('clamps left when the anchor hugs the left edge', () => {
		const placement = placeTooltip(
			{ top: 300, bottom: 320, centerX: 20 },
			{ width: 200, height: 100 },
			{ width: 1280, height: 800 }
		);
		expect(placement.left).toBe(8);
	});

	it('clamps right when the anchor hugs the right edge', () => {
		const placement = placeTooltip(
			{ top: 300, bottom: 320, centerX: 1260 },
			{ width: 200, height: 100 },
			{ width: 1280, height: 800 }
		);
		expect(placement.left).toBe(1280 - 200 - 8);
	});
});
