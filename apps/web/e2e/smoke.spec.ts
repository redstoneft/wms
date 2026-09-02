import { expect, test } from '@playwright/test';
import { uiLogin, USERS } from './helpers';

const OFFICE_ROUTES = ['/', '/map', '/layout', '/masterdata', '/imports', '/inbound/containers', '/inbound/receipts', '/inventory', '/inventory?tab=lpn', '/inventory?tab=movements', '/storage', '/storage?tab=counts', '/orders', '/picking', '/shipments', '/incidents', '/returns', '/labels', '/timeline/SKU-0001', '/account', '/admin/authorizations', '/admin/audit', '/admin/slotting'];
const WM_ROUTES = ['/wm', '/wm/receive', '/wm/putaway', '/wm/transfer', '/wm/replenish', '/wm/count', '/wm/pick', '/wm/stage', '/wm/verify', '/wm/load'];

test.describe('smoke · todas las pantallas cargan sin errores', () => {
  test('modo oficina (supervisor)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await uiLogin(page, USERS.supervisor);
    for (const r of OFFICE_ROUTES) {
      await page.goto(r);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Algo salió mal')).toHaveCount(0);
      await expect(page.getByText('Sin permiso')).toHaveCount(0);
    }
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  test('modo almacén (supervisor)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await uiLogin(page, USERS.supervisor);
    for (const r of WM_ROUTES) {
      await page.goto(r);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Algo salió mal')).toHaveCount(0);
    }
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });

  test('operador sin permiso ve panel "Sin permiso" y no ve navegación de admin', async ({ page }) => {
    await uiLogin(page, USERS.recepcion);
    await page.goto('/admin/audit');
    await expect(page.getByText('Sin permiso')).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Auditoría' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Recepciones' })).toBeVisible();
  });
});
