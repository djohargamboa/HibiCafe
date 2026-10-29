import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}})
function adminKey(){const legacy=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');if(legacy)return legacy;try{const m=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');return m.default||Object.values(m)[0]||null}catch{return null}}
function localBusinessDay(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).formatToParts(new Date());const o=Object.fromEntries(parts.map(p=>[p.type,p.value]));const date=`${o.year}-${o.month}-${o.day}`;if(Number(o.hour)>=3)return date;const d=new Date(date+'T12:00:00+08:00');d.setUTCDate(d.getUTCDate()-1);return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(d)}
const clean=(v:any,max=120)=>String(v??'').trim().slice(0,max)
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return json({error:'Method not allowed'},405)
 const url=Deno.env.get('SUPABASE_URL'),key=adminKey();if(!url||!key)return json({error:'Server configuration is incomplete.'},500)
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
 let body:any;try{body=await req.json()}catch{return json({error:'Invalid request.'},400)}
 const action=clean(body.action,20)
 if(action==='menu'){
  const [{data:menu,error:me},{data:addons,error:ae},{data:settings,error:se},{data:availability,error:av}] = await Promise.all([
   db.from('app_data').select('value').eq('key','hibi-menu').maybeSingle(),
   db.from('app_data').select('value').eq('key','hibi-addons').maybeSingle(),
   db.from('app_data').select('value').eq('key','hibi-settings').maybeSingle(),
   db.from('product_availability').select('product_id,status,business_date')
  ])
  if(me||ae||se||av)return json({error:'Could not load the current menu.'},500)
  const settingsValue=settings?.value||{}
  const open=(settingsValue.onlineOrderingEnabled!==false)
  const today=localBusinessDay()
  const avail:Record<string,string>={}
  for(const a of availability||[])if(a.business_date===today)avail[a.product_id]=a.status
  return json({open,menu:menu?.value||{categories:[],products:[]},addons:addons?.value||[],settings:{gcashQrUrl:settingsValue.gcashQrUrl||'',bpiQrUrl:settingsValue.bpiQrUrl||''},availability:avail})
 }
 if(action==='create'){
  const customerName=clean(body.customerName,80),customerPhone=clean(body.customerPhone,30),serviceType=clean(body.serviceType,20),choice=clean(body.paymentChoice,20),reference=clean(body.paymentReference,100),proof=clean(body.paymentProofUrl,500)
  if(customerName.length<2||customerPhone.length<7)return json({error:'Enter a valid name and mobile number.'},400)
  if(!['Dine In','Take Out'].includes(serviceType))return json({error:'Choose Dine In or Take Out.'},400)
  if(!['Cash','GCash','BPI QR'].includes(choice))return json({error:'Choose a valid payment method.'},400)
  if(choice!=='Cash'&&!reference)return json({error:'Payment reference is required for QR payments.'},400)
  if(proof&&!/^https:\/\//i.test(proof))return json({error:'Payment proof URL must start with https://.'},400)
  if(!Array.isArray(body.items)||body.items.length<1||body.items.length>40)return json({error:'Your cart is empty or too large.'},400)
  const {data:settingsRow}=await db.from('app_data').select('value').eq('key','hibi-settings').maybeSingle()
  if(settingsRow?.value?.onlineOrderingEnabled===false)return json({error:'Online ordering is currently closed.'},403)
  const [{data:menuRow,error:menuErr},{data:addonRow,error:addonErr},{data:availRows,error:availErr}] = await Promise.all([
   db.from('app_data').select('value').eq('key','hibi-menu').single(),
   db.from('app_data').select('value').eq('key','hibi-addons').maybeSingle(),
   db.from('product_availability').select('product_id,status,business_date')
  ])
  if(menuErr||addonErr||availErr)return json({error:'Could not validate the menu.'},500)
  const menu=menuRow.value,addons=addonRow?.value||[],today=localBusinessDay(),avail=new Map((availRows||[]).filter((a:any)=>a.business_date===today).map((a:any)=>[a.product_id,a.status]))
  const items:any[]=[];let subtotal=0
  for(const input of body.items){
   const product=(menu.products||[]).find((p:any)=>p.id===clean(input.productId,80)&&p.active!==false)
   if(!product)return json({error:'A selected product is no longer available. Refresh the menu.'},409)
   if(avail.get(product.id)==='SoldOut')return json({error:product.name+' is sold out. Please update your cart.'},409)
   const size=clean(input.size,60),base=Number(product.sizes?.[size]),qty=Number(input.qty)
   if(!size||!Number.isFinite(base)||base<0||!Number.isInteger(qty)||qty<1||qty>20)return json({error:'A product option or quantity is invalid.'},400)
   const chosen=Array.isArray(input.addonIds)?input.addonIds.slice(0,8):[]
   if(chosen.length && product.addonEligible===false)return json({error:'Add-ons are not available for '+product.name+'.'},400)
   const itemAddons:any[]=[];let addonTotal=0
   for(const id of chosen){const a=addons.find((x:any)=>x.id===clean(id,80)&&x.active!==false);if(!a)return json({error:'An add-on is no longer available. Refresh the menu.'},409);const price=Number(a.price)||0;addonTotal+=price;itemAddons.push({id:a.id,name:a.name,price})}
   const unit=base+addonTotal,line=unit*qty;subtotal+=line
   items.push({product_id:product.id,name:product.name,category:product.category||null,size,is_drink:!!product.isDrink,qty,unit_price:unit,line_total:line,addons:itemAddons})
  }
  const {data:number,error:numberErr}=await db.rpc('next_hibi_order_number')
  if(numberErr||!number)return json({error:'Could not reserve an order number. Please try again.'},500)
  const trackingCode=crypto.randomUUID().replaceAll('-','').slice(0,8).toUpperCase()
  const date=today,time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Manila',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date())
  const isDigital=choice!=='Cash'
  const method=isDigital?'GCash':'Cash'
  const paymentLabel=choice==='BPI QR'?'BPI QR':choice==='GCash'?'GCash QR':'Cash at counter'
  const ref=isDigital?`${paymentLabel}: ${reference}`:null
  const orderPayload={order_number:number,order_date:date,order_time:time,source:'Online',subtotal,discount_type:null,discount_amount:0,total:subtotal,payment_method:method,amount_received:null,cash_amount:null,gcash_amount:isDigital?subtotal:null,change_given:0,gcash_ref:ref,status:'New',payment_status:'Pending',cashier:'Online Customer',service_type:serviceType,customer_name:customerName,customer_phone:customerPhone,tracking_code:trackingCode,payment_proof_url:proof||null,updated_at:new Date().toISOString()}
  const {data:order,error:orderErr}=await db.from('pos_orders').insert(orderPayload).select('id,order_code').single()
  if(orderErr||!order)return json({error:'Could not save your order. Please try again.'},500)
  const itemRows=items.map(i=>({...i,order_id:order.id}))
  const {error:itemErr}=await db.from('pos_order_items').insert(itemRows)
  if(itemErr){await db.from('pos_orders').delete().eq('id',order.id);return json({error:'Order items could not be saved. Please try again.'},500)}
  return json({ok:true,orderNumber:order.order_code||`HIBI-${String(number).padStart(4,'0')}`,trackingCode,total:subtotal,paymentMethod:method,paymentLabel,paymentStatus:'Pending'})
 }
 if(action==='track'){
  const orderNumber=clean(body.orderNumber,30).toUpperCase(),trackingCode=clean(body.trackingCode,12).toUpperCase()
  if(!/^HIBI-\d{1,8}$/.test(orderNumber)||!/^[A-F0-9]{8}$/.test(trackingCode))return json({error:'Enter the order number and tracking code exactly as shown.'},400)
  const {data:order,error}=await db.from('pos_orders').select('order_code,status,payment_status,service_type,total,created_at,updated_at').eq('order_code',orderNumber).eq('tracking_code',trackingCode).maybeSingle()
  if(error||!order)return json({error:'Order not found. Check the order number and private tracking code.'},404)
  return json({orderNumber:order.order_code,status:order.status,paymentStatus:order.payment_status,serviceType:order.service_type,total:Number(order.total)||0,updatedAt:order.updated_at||order.created_at})
 }
 return json({error:'Unknown action.'},400)
})
