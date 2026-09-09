import { describe, expect, it } from 'vitest';
import { assignableBy, can } from './roles';

describe('role policy', () => {
	it('lets a pilot maintain aircraft, checklists and batteries but not delete aircraft', () => {
		expect(can(['пилот'], 'C', 'борт')).toBe(true);
		expect(can(['пилот'], 'U', 'борт')).toBe(true);
		expect(can(['пилот'], 'D', 'борт')).toBe(false);
		expect(can(['пилот'], 'D', 'чеклист')).toBe(true);
		expect(can(['пилот'], 'D', 'аккумуляторы')).toBe(true);
	});

	it('lets a pilot amend a team scheduled plan but keeps completed records read-only', () => {
		expect(can(['пилот'], 'U', 'план', { own: false })).toBe(true);
		expect(can(['пилот'], 'D', 'план', { own: false })).toBe(true);
		expect(can(['пилот'], 'U', 'запись', { own: true })).toBe(false);
	});

	it('gives an observer read-only access and reserves administrator appointments for owner', () => {
		expect(can(['наблюдатель'], 'R', 'аккумуляторы')).toBe(true);
		expect(can(['наблюдатель'], 'U', 'аккумуляторы')).toBe(false);
		expect(assignableBy(['администратор'])).not.toContain('администратор');
		expect(assignableBy(['владелец'])).toContain('администратор');
	});

	it('keeps the owner fully operational on fleet and checklist screens', () => {
		expect(can(['владелец'], 'U', 'борт')).toBe(true);
		expect(can(['владелец'], 'D', 'чеклист')).toBe(true);
		expect(can(['владелец', 'администратор'], 'U', 'план')).toBe(true);
		expect(can(['владелец', 'администратор'], 'D', 'план')).toBe(true);
	});
});
