-- Add optional dine-in / take-out metadata to POS orders.
-- Existing orders remain NULL so historical service types are not guessed.
ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS service_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pos_orders_service_type_check'
      AND conrelid = 'public.pos_orders'::regclass
  ) THEN
    ALTER TABLE public.pos_orders
      ADD CONSTRAINT pos_orders_service_type_check
      CHECK (service_type IS NULL OR service_type IN ('Dine In', 'Take Out'));
  END IF;
END $$;

-- Keep the existing idempotent order submission path and validate the new field.
CREATE OR REPLACE FUNCTION public.hibi_create_order_v2(p_request_id uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
 v_existing hibi_requests%ROWTYPE;
 v_order jsonb;
 v_date date;
 v_item jsonb;
 v_total numeric;
 v_sub numeric;
 v_discount numeric;
 v_sum numeric := 0;
 v_method text;
 v_service_type text;
BEGIN
 IF NOT hibi_is_active_user() THEN RAISE EXCEPTION 'Active login required'; END IF;
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'Submission reference is required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 SELECT * INTO v_existing FROM hibi_requests WHERE id=p_request_id;
 IF FOUND THEN
  IF v_existing.actor<>auth.uid() OR v_existing.kind<>'order' OR v_existing.payload<>p_payload THEN RAISE EXCEPTION 'Submission reference mismatch'; END IF;
  RETURN v_existing.result;
 END IF;
 IF NOT hibi_has_permission(CASE WHEN p_payload->>'p_source'='GrabFood' THEN 'grab' ELSE 'pos' END) THEN RAISE EXCEPTION 'Order permission required'; END IF;
 v_date:=(p_payload->>'p_order_date')::date;
 PERFORM hibi_check_day(v_date);
 IF v_date=hibi_business_day() AND NOT EXISTS(SELECT 1 FROM cash_shifts WHERE business_date=v_date AND status='Open') THEN RAISE EXCEPTION 'Open a shift first'; END IF;
 IF coalesce(p_payload->>'p_source','') NOT IN ('Walk-in','GrabFood') THEN RAISE EXCEPTION 'Invalid channel'; END IF;

 v_service_type:=nullif(btrim(p_payload->>'p_service_type'),'');
 IF p_payload->>'p_source'='GrabFood' THEN
  IF v_service_type IS NOT NULL AND v_service_type<>'Take Out' THEN RAISE EXCEPTION 'GrabFood orders must be Take Out'; END IF;
  v_service_type:='Take Out';
 ELSIF v_service_type IS NOT NULL AND v_service_type NOT IN ('Dine In','Take Out') THEN
  RAISE EXCEPTION 'Invalid service type';
 END IF;

 v_total:=(p_payload->>'p_total')::numeric;
 v_sub:=(p_payload->>'p_subtotal')::numeric;
 v_discount:=(p_payload->>'p_discount_amount')::numeric;
 IF v_total IS NULL OR v_sub IS NULL OR v_discount IS NULL OR v_total NOT BETWEEN 0 AND 9999999999.99 OR v_sub NOT BETWEEN 0 AND 9999999999.99 OR v_discount NOT BETWEEN 0 AND 9999999999.99 OR v_discount>v_sub OR round(v_total,2)<>round(v_sub-v_discount,2) THEN RAISE EXCEPTION 'Invalid order totals'; END IF;
 IF jsonb_typeof(p_payload->'p_items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'p_items')=0 THEN RAISE EXCEPTION 'Order requires items'; END IF;
 FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'p_items') LOOP
  IF (v_item->>'qty')::numeric IS NULL OR (v_item->>'qty')::numeric NOT BETWEEN 1 AND 10000 OR (v_item->>'qty')::numeric<>trunc((v_item->>'qty')::numeric) OR
   (v_item->>'unitPrice')::numeric IS NULL OR (v_item->>'unitPrice')::numeric NOT BETWEEN 0 AND 9999999999.99 OR (v_item->>'lineTotal')::numeric IS NULL OR
   round((v_item->>'lineTotal')::numeric,2)<>round((v_item->>'qty')::numeric*(v_item->>'unitPrice')::numeric,2) THEN RAISE EXCEPTION 'Invalid item quantity or price'; END IF;
  v_sum:=v_sum+(v_item->>'lineTotal')::numeric;
 END LOOP;
 -- Loyalty rewards are already reduced in item lines; ordinary discounts are order-level.
 IF round(v_sum,2)<round(v_total,2) OR round(v_sum,2)>round(v_sub,2) THEN RAISE EXCEPTION 'Item totals do not match order'; END IF;
 v_method:=p_payload->>'p_payment_method';
 IF v_method IS NULL OR v_method NOT IN ('Cash','GCash','Cash + GCash','GrabFood') THEN RAISE EXCEPTION 'Invalid payment method'; END IF;
 IF (p_payload->>'p_source'='GrabFood') IS DISTINCT FROM (v_method='GrabFood') THEN RAISE EXCEPTION 'Payment does not match channel'; END IF;
 IF v_method='Cash + GCash' AND (coalesce((p_payload->>'p_cash_amount')::numeric,-1)<0 OR coalesce((p_payload->>'p_gcash_amount')::numeric,-1)<0 OR round((p_payload->>'p_cash_amount')::numeric+(p_payload->>'p_gcash_amount')::numeric,2)<>round(v_total,2)) THEN RAISE EXCEPTION 'Split payments do not match total'; END IF;
 IF v_method IN ('Cash','Cash + GCash') AND (coalesce((p_payload->>'p_amount_received')::numeric,-1)<v_total OR round((p_payload->>'p_amount_received')::numeric-v_total,2)<>round(coalesce((p_payload->>'p_change_given')::numeric,-1),2)) THEN RAISE EXCEPTION 'Invalid tender or change'; END IF;
 IF v_method='GrabFood' AND nullif(btrim(p_payload->>'p_grab_code'),'') IS NULL THEN RAISE EXCEPTION 'Grab reference required'; END IF;

 v_order:=create_hibi_pos_order(p_payload->>'p_source',p_payload->>'p_grab_code',v_date,
  (now() AT TIME ZONE 'Asia/Manila')::time,now(),v_sub,p_payload->>'p_discount_type',v_discount,v_total,v_method,
  (p_payload->>'p_amount_received')::numeric,(p_payload->>'p_cash_amount')::numeric,(p_payload->>'p_gcash_amount')::numeric,
  (p_payload->>'p_change_given')::numeric,p_payload->>'p_gcash_ref','Preparing',hibi_actor(),p_payload->'p_items');
 UPDATE pos_orders
 SET created_by=auth.uid(),
     service_type=v_service_type,
     grab_fee_rate=coalesce((SELECT rate FROM hibi_fee_rates WHERE effective_date<=v_date ORDER BY effective_date DESC LIMIT 1),0.25)
 WHERE id=(v_order->>'id')::uuid;
 SELECT to_jsonb(o)||jsonb_build_object('items',v_order->'items') INTO v_order FROM pos_orders o WHERE id=(v_order->>'id')::uuid;
 INSERT INTO hibi_requests(id,actor,kind,payload,result) VALUES(p_request_id,auth.uid(),'order',p_payload,v_order);
 RETURN v_order;
END
$function$;
