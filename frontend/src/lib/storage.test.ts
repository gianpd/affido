import { describe, expect, it } from 'vitest';
import {
	hostIsBinding,
	pieSlice,
	storageAlert,
	storageUsedColor,
	storageUsedFraction
} from './storage';
import type { StorageReport } from './types';

const report = (fields: Partial<StorageReport>): StorageReport => ({
	quotaBytes: 1000,
	usedBytes: 0,
	availableBytes: 1000,
	hostFreeBytes: null,
	usedPercent: 0,
	state: 'ok',
	partial: false,
	checkedAt: 0,
	...fields
});

describe('storageUsedFraction', () => {
	it('clamps out-of-range bytes to the quota', () => {
		expect(storageUsedFraction(report({ usedBytes: 250 }))).toBe(0.25);
		expect(storageUsedFraction(report({ usedBytes: 5000 }))).toBe(1);
		expect(storageUsedFraction(report({ usedBytes: -10 }))).toBe(0);
		expect(storageUsedFraction(report({ quotaBytes: 0, usedBytes: 10 }))).toBe(1);
	});
});

describe('pieSlice', () => {
	it('starts at 12 o clock and marks a wedge over half the circle as large', () => {
		expect(pieSlice(0, 0.25)).toBe('M 0 0 L 0.00000 -1.00000 A 1 1 0 0 1 1.00000 0.00000 Z');
		expect(pieSlice(0, 0.75)).toContain('A 1 1 0 1 1');
	});
});

describe('alerts', () => {
	it('shows no alert while ok and names the 507 refusal when full', () => {
		expect(storageAlert(report({ state: 'ok' }))).toBeNull();
		expect(storageAlert(report({ state: 'warning' }))?.title).toBe('Storage is filling up');
		expect(storageAlert(report({ state: 'critical' }))?.title).toBe('Storage almost full');
		expect(storageAlert(report({ state: 'full' }))?.description).toContain('507');
	});

	it('uses the destructive token and detects a binding host disk', () => {
		expect(storageUsedColor(report({ state: 'ok' }))).toBe('var(--chart-1)');
		expect(storageUsedColor(report({ state: 'critical' }))).toBe('var(--destructive)');
		expect(hostIsBinding(report({ usedBytes: 100, hostFreeBytes: 50 }))).toBe(true);
		expect(hostIsBinding(report({ usedBytes: 100, hostFreeBytes: 50_000 }))).toBe(false);
		expect(hostIsBinding(report({ hostFreeBytes: null }))).toBe(false);
	});
});
