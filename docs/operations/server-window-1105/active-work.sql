BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT json_build_object(
 'pending_payment_attempts', (SELECT count(*) FROM commerce_payment_attempts WHERE state IN ('pending','unknown')),
 'unsettled_invoices', (SELECT count(*) FROM commerce_kaspi_invoices WHERE state IN ('issuing','issued','unknown')),
 'unsettled_qr', (SELECT count(*) FROM commerce_kiosk_kaspi_qr WHERE state IN ('issuing','issued','unknown')),
 'pending_refunds', (SELECT count(*) FROM commerce_refunds WHERE state IN ('pending','unknown')),
 'active_edge_fulfillment', (SELECT count(*) FROM cloud_fulfillment_projection WHERE state IN ('held','accepted','in_production','ready','cancel_requested')),
 'active_cloud_kitchen', (SELECT count(*) FROM cloud_kitchen_orders WHERE state NOT IN ('handed_over','cancelled')),
 'paid_unfinished_orders', (SELECT count(*) FROM commerce_orders o
   WHERE EXISTS (SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
     AND NOT EXISTS (SELECT 1 FROM cloud_fulfillment_projection f WHERE f.order_id=o.id AND f.state IN ('handed_over','cancelled','released'))
     AND NOT EXISTS (SELECT 1 FROM cloud_kitchen_orders k WHERE k.order_id=o.id AND k.state IN ('handed_over','cancelled'))
     AND (SELECT coalesce(sum(c.amount_minor),0) FROM commerce_captures c WHERE c.order_id=o.id)
       > (SELECT coalesce(sum(e.amount_minor),0) FROM commerce_refund_effects e WHERE e.order_id=o.id))
);
COMMIT;
