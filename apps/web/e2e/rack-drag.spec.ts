import { expect, test } from '@playwright/test';
import { apiLogin, uiLogin, USERS } from './helpers';

// Edit mode: a rack can be dragged on the 3D floor; dropping it persists the new origin (PATCH /racks/:id).
test.describe('mapa 3D · modo edición', () => {
  test('arrastrar un rack lo mueve y guarda la nueva posición', async ({ page }) => {
    const api = await apiLogin(USERS.supervisor);
    // demo warehouse: pick a rack location to fly the camera to it
    const locs = await (await api.get('/api/locations?type=RESERVE&limit=1')).json();
    const rows = locs.items ?? locs;
    const loc = rows[0];
    expect(loc?.rack_id).toBeTruthy();
    const before = (await (await api.get('/api/map?warehouse_id=' + loc.warehouse_id)).json()).racks.find((r: { id: string }) => r.id === loc.rack_id);

    await uiLogin(page, USERS.supervisor);
    await page.goto('/map');
    await page.getByTestId('map-warehouse').selectOption(loc.warehouse_id);
    await expect(page.locator('[data-testid="map-page"] canvas')).toBeVisible();
    await page.getByLabel('Modo edición').check();
    // fly to the location: the camera centres on it, so the rack body is under the canvas centre
    await page.getByTestId('map-search-type').selectOption('LOCATION');
    await page.getByTestId('map-search-input').fill(loc.code);
    await page.getByTestId('map-search-submit').click();
    await expect(page.getByTestId('map-hits')).toContainText(loc.code);
    await page.waitForTimeout(1500); // fly animation
    const canvas = page.locator('[data-testid="map-page"] canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 8, cy + i * 3);
    await page.mouse.up();
    await expect(page.getByText('Rack movido')).toBeVisible({ timeout: 10_000 });
    const after = (await (await api.get('/api/map?warehouse_id=' + loc.warehouse_id)).json()).racks.find((r: { id: string }) => r.id === loc.rack_id);
    expect(after.x_m !== before.x_m || after.y_m !== before.y_m).toBeTruthy();
    // restore the demo layout
    const ctx = await apiLogin(USERS.supervisor);
    const r = await ctx.patch(`/api/racks/${loc.rack_id}`, { data: { x_m: before.x_m, y_m: before.y_m } });
    expect(r.ok()).toBeTruthy();
  });
});
