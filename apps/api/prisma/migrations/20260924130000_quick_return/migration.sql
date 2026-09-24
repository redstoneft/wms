-- Quick returns from the handheld: one or two pieces go straight onto the pallet that already holds the product.
-- The customer is optional on these returns.
ALTER TABLE returns ALTER COLUMN customer_id DROP NOT NULL;
