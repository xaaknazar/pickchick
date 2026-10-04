-- Free placement on a 64x64 field; at most 4095 occupied cells and one fixed house.
-- Preserve existing state; application upgrades version1 lazily under the customer lock.
ALTER TABLE customer_farms DROP CONSTRAINT customer_farms_state_check;
ALTER TABLE customer_farms ADD CONSTRAINT customer_farms_state_check
 CHECK (jsonb_typeof(state)='object' AND octet_length(state::text)<=1048576);
