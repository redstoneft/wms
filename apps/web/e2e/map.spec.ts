import { expect, test } from '@playwright/test';
import { uiLogin, USERS } from './helpers';

test.describe('mapa 3D (digital twin)', () => {
  test('renderiza el canvas, leyenda y ocupación; buscar SKU resalta y lista ubicaciones', async ({ page }) => {
    await uiLogin(page, USERS.supervisor);
    await page.goto('/map');
    await expect(page.getByTestId('map-page')).toBeVisible();
    // several warehouses may exist (the real nave has no racks yet): this test is about the seeded demo warehouse
    await page.getByTestId('map-warehouse').selectOption({ label: 'CEDIS-01 · CEDIS Principal' });
    const canvas = page.locator('[data-testid="map-page"] canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId('map-legend')).toContainText('Ocupada');
    await expect(page.getByTestId('map-legend')).toContainText(/\d+ posiciones · \d+ pallets/);
    await expect(page.getByTestId('map-occupancy')).toContainText('Almacén');

    // search a seeded SKU → hits list in the side panel
    await page.getByTestId('map-search-input').fill('SKU-0001');
    await page.getByTestId('map-search-submit').click();
    const hits = page.getByTestId('map-hits');
    await expect(hits).toBeVisible();
    await expect(hits).toContainText('SKU SKU-0001');
    await expect(hits).toContainText(/\d+ resultado/);
    // seeded pallets of SKU-0001 live in rack slots (received e2e pallets may also sit on a dock)
    const rackHit = hits.locator('li', { hasText: /[A-Z]-\d{2}-R\d{2}-N\d{2}-P\d{2}/ }).first();
    await expect(rackHit).toBeVisible();
    await expect(rackHit).toContainText('PLT-');

    // clicking a hit opens the location detail with its LPNs
    await rackHit.locator('button').click();
    await expect(page.getByTestId('map-selected')).toBeVisible();
    await expect(page.getByTestId('map-selected')).toContainText('LPNs');
    await expect(page.getByTestId('map-selected')).toContainText('SKU-0001');

    // Esc clears selection
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('map-selected')).toHaveCount(0);
  });

  test('búsqueda de LPN inexistente avisa sin resultados', async ({ page }) => {
    await uiLogin(page, USERS.supervisor);
    await page.goto('/map');
    await page.locator('select[aria-label="Tipo de búsqueda"]').selectOption('LPN');
    await page.getByTestId('map-search-input').fill('PLT-0000-99999999');
    await page.getByTestId('map-search-submit').click();
    await expect(page.getByText('Sin resultados')).toBeVisible();
  });
});
