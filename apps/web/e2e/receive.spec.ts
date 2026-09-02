import { expect, test } from '@playwright/test';
import { apiLogin, createReceipt, scan, uiLogin, USERS } from './helpers';

test.describe('modo almacén · recepción', () => {
  test('escanear producto + cantidad crea un LPN', async ({ page }) => {
    const api = await apiLogin(USERS.recepcion);
    const receipt = await createReceipt(api);

    await uiLogin(page, USERS.recepcion);
    await page.goto(`/wm/receive?receipt=${receipt.id}`);
    await expect(page.getByTestId('wm-step')).toContainText('ESCANEA EL PRODUCTO');

    // barcode of SKU-0001 at PIECE level (seeded)
    await scan(page, 'scan-product', '7501000000001');
    await expect(page.getByTestId('wm-step')).toContainText('CANTIDAD');
    await expect(page.getByTestId('qty-pad')).toBeVisible();

    // type qty via keypad and confirm
    await page.getByRole('button', { name: '1', exact: true }).click();
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(page.getByTestId('qty-value')).toHaveText('12');
    await page.getByTestId('qty-confirm').click();

    await expect(page.getByTestId('wm-step')).toContainText('PALLET REGISTRADO');
    const lpn = (await page.getByTestId('result-lpn').textContent())?.trim() ?? '';
    expect(lpn).toMatch(/^PLT-\d{4}-\d{8}$/);

    // the LPN exists in the API with 12 pieces of SKU-0001
    const r = await api.get(`/api/inventory/lpns/${lpn}`);
    expect(r.ok()).toBeTruthy();
    const body = (await r.json()) as { code: string; status: string; receipt_id: string; balances: { qty: string; sku: { code: string } }[] };
    expect(body.receipt_id).toBe(receipt.id);
    expect(body.status).toBe('OPEN');
    expect(body.balances.some((b) => b.sku.code === 'SKU-0001' && b.qty === '12')).toBeTruthy();

    // close the pallet from the handheld → put-away task
    await page.getByTestId('close-lpn').click();
    await expect(page.getByTestId('wm-step')).toContainText('ESCANEA EL PRODUCTO');
    const sup = await apiLogin(USERS.supervisor); // recepcion lacks putaway.execute
    const tasks = await sup.get('/api/putaway/tasks');
    expect(tasks.ok(), await tasks.text()).toBeTruthy();
    const list = (await tasks.json()) as { lpn_code: string }[];
    expect(list.some((t) => t.lpn_code === lpn)).toBeTruthy();
  });

  test('código desconocido muestra error bloqueante con OK', async ({ page }) => {
    const api = await apiLogin(USERS.recepcion);
    const receipt = await createReceipt(api);
    await uiLogin(page, USERS.recepcion);
    await page.goto(`/wm/receive?receipt=${receipt.id}`);
    await scan(page, 'scan-product', 'NO-EXISTE-123');
    await expect(page.getByTestId('wm-error')).toBeVisible();
    await expect(page.getByTestId('wm-error-message')).toContainText('NO-EXISTE-123');
    await page.getByTestId('wm-error-ok').click();
    await expect(page.getByTestId('wm-error')).toHaveCount(0);
  });
});
