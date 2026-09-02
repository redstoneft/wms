import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSIONS, permissionsForRoles, ROLE_PERMISSIONS } from './permissions.js';
import { ROLES } from './enums.js';

describe('RBAC matrix', () => {
  it('every role only references defined permissions', () => {
    for (const r of ROLES) for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toHaveProperty(p);
  });
  it('ADMIN has everything; SUPERVISOR everything except user/settings management', () => {
    expect(new Set(ROLE_PERMISSIONS.ADMIN)).toEqual(new Set(ALL_PERMISSIONS));
    expect(ROLE_PERMISSIONS.SUPERVISOR).not.toContain('users.manage');
    expect(ROLE_PERMISSIONS.SUPERVISOR).not.toContain('settings.manage');
    expect(ROLE_PERMISSIONS.SUPERVISOR).toContain('shipments.release');
  });
  it('separation of duties: operators cannot release shipments, approve counts, or authorize exceptions', () => {
    for (const r of ['RECEIVING', 'FORKLIFT', 'PICKER', 'VERIFIER', 'LOADER'] as const) {
      expect(ROLE_PERMISSIONS[r]).not.toContain('shipments.release');
      expect(ROLE_PERMISSIONS[r]).not.toContain('counts.approve');
      expect(ROLE_PERMISSIONS[r]).not.toContain('exceptions.authorize');
      expect(ROLE_PERMISSIONS[r]).not.toContain('inventory.adjust');
      expect(ROLE_PERMISSIONS[r]).not.toContain('users.manage');
    }
    expect(ROLE_PERMISSIONS.PICKER).not.toContain('verification.execute');
    expect(ROLE_PERMISSIONS.VERIFIER).not.toContain('picking.execute');
    expect(ROLE_PERMISSIONS.LOADER).not.toContain('picking.execute');
  });
  it('permissionsForRoles unions roles', () => {
    const p = permissionsForRoles(['PICKER', 'VERIFIER']);
    expect(p.has('picking.execute')).toBe(true);
    expect(p.has('verification.execute')).toBe(true);
    expect(p.has('shipments.release')).toBe(false);
  });
});
