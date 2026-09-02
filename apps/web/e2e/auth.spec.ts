import { expect, test } from '@playwright/test';
import { uiLoginForm as uiLogin, USERS } from './helpers';

test.describe('autenticación y tablero', () => {
  test('login inválido muestra error', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-username').fill('supervisor');
    await page.getByTestId('login-password').fill('mala');
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('alert')).toContainText(/incorrectos/i);
  });

  test('login + dashboard renderiza tarjetas y KPIs', async ({ page }) => {
    await uiLogin(page, USERS.supervisor);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Tablero operativo' })).toBeVisible();
    await expect(page.getByText('Contenedores esperando')).toBeVisible();
    await expect(page.getByText('Ocupación de almacén')).toBeVisible();
    await expect(page.getByText('Indicadores (KPIs)')).toBeVisible();
    await expect(page.getByText('Exactitud de inventario')).toBeVisible();
    // navigation reflects permissions: supervisor sees admin authorizations but not users management
    await expect(page.getByRole('link', { name: 'Autorizaciones' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Usuarios' })).toHaveCount(0);
  });

  test('ruta protegida redirige a login', async ({ page }) => {
    await page.goto('/orders');
    await expect(page).toHaveURL(/\/login/);
  });
});
