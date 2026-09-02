import { expect, test } from '@playwright/test';
import { apiLogin, createReceipt, receiveAndClosePallet, scan, uiLogin, USERS } from './helpers';

test.describe('modo almacén · put-away', () => {
  test('ubicación incorrecta muestra error bloqueante UBICACIÓN INCORRECTA', async ({ page }) => {
    const recv = await apiLogin(USERS.recepcion);
    const receipt = await createReceipt(recv);
    const lpn = await receiveAndClosePallet(recv, receipt.id);

    await uiLogin(page, USERS.montacargas);
    await page.goto('/wm/putaway');
    await scan(page, 'scan-lpn', lpn);
    const target = await page.getByTestId('target-location').textContent();
    expect(target).toMatch(/^[A-Z]-\d{2}-R\d{2}-N\d{2}-P\d{2}$/);

    // a RECEIVING dock is never the suggested storage slot → WRONG_LOCATION
    await scan(page, 'scan-location', 'LOC-DOCK-02');
    await expect(page.getByTestId('wm-error')).toBeVisible();
    await expect(page.getByTestId('wm-error')).toContainText('UBICACIÓN INCORRECTA');
    await expect(page.getByTestId('wm-error')).toContainText(target!);
    await page.getByTestId('wm-error-ok').click();
    // override panel offers the supervisor authorization path
    await expect(page.getByTestId('override-panel')).toBeVisible();

    // scanning the correct location confirms the put-away
    await scan(page, 'scan-location', `LOC-${target}`);
    await expect(page.getByText(/Último pallet ubicado/)).toBeVisible();
    const api = await apiLogin(USERS.montacargas);
    const r = await api.get(`/api/inventory/lpns/${lpn}`);
    const body = (await r.json()) as { status: string; current_location: { code: string } };
    expect(body.status).toBe('STORED');
    expect(body.current_location.code).toBe(target);
  });
});
