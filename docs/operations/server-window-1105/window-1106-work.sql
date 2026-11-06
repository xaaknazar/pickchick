BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
WITH edge_active AS (
 SELECT f.order_id,f.state,f.version,f.observed_at,o.created_at
 FROM cloud_fulfillment_projection f JOIN commerce_orders o ON o.id=f.order_id
 WHERE f.state IN ('held','accepted','in_production','ready','cancel_requested')
), paid_open AS (
 SELECT o.id,o.created_at,o.updated_at,o.state,o.version
 FROM commerce_orders o
 WHERE EXISTS (SELECT 1 FROM commerce_captures c WHERE c.order_id=o.id)
 AND NOT EXISTS (SELECT 1 FROM cloud_fulfillment_projection f WHERE f.order_id=o.id AND f.state IN ('handed_over','cancelled','released'))
 AND NOT EXISTS (SELECT 1 FROM cloud_kitchen_orders k WHERE k.order_id=o.id AND k.state IN ('handed_over','cancelled'))
 AND (SELECT coalesce(sum(c.amount_minor),0) FROM commerce_captures c WHERE c.order_id=o.id)
   > (SELECT coalesce(sum(e.amount_minor),0) FROM commerce_refund_effects e WHERE e.order_id=o.id)
)
SELECT json_build_object(
 'observed_at',clock_timestamp(),
 'historical_cutoff','2026-11-01T00:00:00+05:00',
 'pending_payment_attempts',(SELECT count(*) FROM commerce_payment_attempts WHERE state IN ('pending','unknown')),
 'unsettled_invoices',(SELECT count(*) FROM commerce_kaspi_invoices WHERE state IN ('issuing','issued','unknown')),
 'unsettled_qr',(SELECT count(*) FROM commerce_kiosk_kaspi_qr WHERE state IN ('issuing','issued','unknown')),
 'pending_refunds',(SELECT count(*) FROM commerce_refunds WHERE state IN ('pending','unknown')),
 'active_cloud_kitchen',(SELECT count(*) FROM cloud_kitchen_orders WHERE state NOT IN ('handed_over','cancelled')),
 'edge_active_total',(SELECT count(*) FROM edge_active),
 'edge_created_on_or_after_cutoff',(SELECT count(*) FROM edge_active WHERE created_at>='2026-11-01T00:00:00+05:00'),
 'edge_latest_order_created_at',(SELECT max(created_at) FROM edge_active),
 'edge_set_fingerprint',(SELECT md5(coalesce(jsonb_agg(to_jsonb(e) ORDER BY order_id)::text,'')) FROM edge_active e),
 'edge_historical_fingerprint',(SELECT md5(coalesce(jsonb_agg(to_jsonb(e) ORDER BY order_id)::text,'')) FROM edge_active e WHERE created_at<'2026-11-01T00:00:00+05:00'),
 'paid_open_total',(SELECT count(*) FROM paid_open),
 'paid_created_on_or_after_cutoff',(SELECT count(*) FROM paid_open WHERE created_at>='2026-11-01T00:00:00+05:00'),
 'paid_latest_order_created_at',(SELECT max(created_at) FROM paid_open),
 'paid_set_fingerprint',(SELECT md5(coalesce(jsonb_agg(to_jsonb(o) ORDER BY id)::text,'')) FROM paid_open o),
 'paid_historical_fingerprint',(SELECT md5(coalesce(jsonb_agg(to_jsonb(o) ORDER BY id)::text,'')) FROM paid_open o WHERE created_at<'2026-11-01T00:00:00+05:00')
);
COMMIT;
