/* Phase 1: database-backed financial records, shared reporting and safe submissions. */
let REFUNDS=[], FEE_RATES=[], p1Epoch=0;
const p1Ranges=new Map(), p1Loads=new Map(), p1RenderVersions={};
const originalPosApi=posApi;
posApi=async function(path,options={}){
  const readRpc=/\/rpc\/hibi_snapshot(?:\?|$)/.test(path);
  try{
    const response=await originalPosApi(path,options);
    if(options.method && options.method!=='GET' && !readRpc){p1Epoch++;p1Ranges.clear();}
    return response;
  }catch(error){
    if(/\/rpc\/hibi_/.test(path)&&/404|PGRST202/.test(error.message)) error.message='Phase 1 database update is required. Apply phase1/migration.sql before using this version.';
    throw error;
  }
};
function p1Range(filter={mode:'today'}){
  const today=businessDayKey();
  if(filter.mode==='date') return [filter.date||today,filter.date||today];
  if(filter.mode==='range') return [filter.start,filter.end];
  if(filter.mode==='month') return [today.slice(0,7)+'-01',today];
  if(filter.mode==='all') return ['1900-01-01',today];
  return [today,today];
}
function p1MonthlyRange(){const m=monthlyPerformanceMonth||businessDayKey().slice(0,7);return [m+'-01',monthDateRange(m).end];}
function p1Merge(old,rows,start,end,key='date'){
  return [...old.filter(x=>x[key]<start||x[key]>end),...rows];
}
async function p1Load(start,end,force=false){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(start||'')||!/^\d{4}-\d{2}-\d{2}$/.test(end||'')||end<start) throw Error('Choose a valid date range.');
  const key=start+'/'+end, epoch=p1Epoch;
  if(!force && Date.now()-(p1Ranges.get(key)||0)<15000) return;
  const loadKey=key+'/'+epoch;
  if(p1Loads.has(loadKey)) return p1Loads.get(loadKey);
  const promise=(async()=>{
    const res=await posApi('/rest/v1/rpc/hibi_snapshot',{method:'POST',body:JSON.stringify({p_start:start,p_end:end})});
    const data=await res.json();
    if(!Array.isArray(data.orders)||!Array.isArray(data.refunds)) throw Error('Incomplete database snapshot.');
    if(epoch!==p1Epoch) return p1Load(start,end,true);
    ORDERS=p1Merge(ORDERS,data.orders.map(mapDbOrder),start,end);
    EXPENSES=p1Merge(EXPENSES,data.expenses.map(mapExpenseRow),start,end);
    OWNER_EXPENSES=p1Merge(OWNER_EXPENSES,data.ownerExpenses.map(mapOwnerExpenseRow),start,end);
    CASH_MOVEMENTS=p1Merge(CASH_MOVEMENTS,data.cashMovements.map(mapCashMovementRow),start,end);
    SHIFTS=p1Merge(SHIFTS,data.shifts.map(mapShiftRow),shiftCalendarDate(start,-1),end,'businessDate');
    REFUNDS=p1Merge(REFUNDS,data.refunds,start,end,'business_date');
    for(const key of Object.keys(EOD)) if(key>=shiftCalendarDate(start,-1)&&key<=end) delete EOD[key];
    data.eod.forEach(row=>EOD[row.business_date]=mapEodRow(row));
    FEE_RATES=data.fees||[];SETTINGS.nextOrderNum=data.nextOrderNumber||SETTINGS.nextOrderNum;
    p1Ranges.clear();p1Ranges.set(key,Date.now());
  })().finally(()=>p1Loads.delete(loadKey));
  p1Loads.set(loadKey,promise);return promise;
}
const p1MapDbOrder=mapDbOrder;
mapDbOrder=function(row){return {...p1MapDbOrder(row),paymentStatus:row.payment_status|| (row.status==='Cancelled'?'LegacyCancelled':'Paid'),grabFeeRate:Number(row.grab_fee_rate??.25),completedAt:row.completed_at||null};};
loadAll=async function(){
  MENU=await storeGet('hibi-menu',MENU);ADDONS=await storeGet('hibi-addons',ADDONS);SETTINGS=await storeGet('hibi-settings',SETTINGS);applyBranding();
  ORDERS=[];EXPENSES=[];OWNER_EXPENSES=[];CASH_MOVEMENTS=[];SHIFTS=[];REFUNDS=[];EOD={};p1Ranges.clear();
  const today=businessDayKey();await Promise.all([p1Load(today.slice(0,7)+'-01',today,true),loadProductAvailability()]);
};
loadPosOrders=async function(){const day=selectedOrderDate||businessDayKey();await p1Load(day,day,true);};
loadFinancialRows=loadShifts=async function(){const day=businessDayKey();await p1Load(day,day,true);};
function p1Refunds(start,end=start){return REFUNDS.filter(r=>!r.voided_at&&r.business_date>=start&&r.business_date<=end);}
function p1IsCancelled(o){return !!o&&(o.status==='Cancelled'||o.status==='LegacyCancelled'||(o.paymentStatus||o.payment_status)==='LegacyCancelled');}
function p1RefundOrder(r,orders=[]){return orders.find(o=>o.id===r.order_id)|| (r.order?mapDbOrder(r.order):ORDERS.find(o=>o.id===r.order_id));}
function p1RefundedOnly(refunds,orders=[]){return refunds.filter(r=>r.kind==='Refund'&&!r.voided_at&&!p1IsCancelled(p1RefundOrder(r,orders)));}
const cents=n=>Math.round(Number(n||0)*100), money=n=>n/100;
function p1Parts(o){return o.paymentMethod==='Cash + GCash'?{Cash:Number(o.cashAmount||0),GCash:Number(o.gcashAmount||0)}:{[o.paymentMethod]:Number(o.total||0)};}
function p1RemainingParts(o){
 const remaining={Cash:0,GCash:0,GrabFood:0};
 for(const [method,value] of Object.entries(p1Parts(o))) remaining[method]=Math.max(0,Number(value)||0);
 for(const r of REFUNDS.filter(x=>x.order_id===o.id&&!x.voided_at)){
  remaining.Cash=Math.max(0,remaining.Cash-Number(r.cash_amount||0));
  remaining.GCash=Math.max(0,remaining.GCash-Number(r.gcash_amount||0));
  remaining.GrabFood=Math.max(0,remaining.GrabFood-Number(r.grab_amount||0));
 }
 return remaining;
}
computeMetrics=function(orders,refunds=[]){
  // Cancellation refunds belong to cancelled orders and are already excluded
  // from sales. Only ordinary Refund records reduce reported sales totals.
  refunds=p1RefundedOnly(refunds,orders);
  const paid=orders.filter(o=>!p1IsCancelled(o));
  const pmAgg={},sourceAgg={'Walk-in':{count:0,sales:0,items:0,cups:0,discounts:0},GrabFood:{count:0,sales:0,items:0,cups:0,discounts:0}},productAgg={};
  const cupBySize={'Hot 12oz':0,'Iced 16oz':0,'Iced 20oz':0};let cups=0,foodItems=0,gross=0,refundCents=0,fees=0;
  function products(items,amount,quantity){
    const total=items.reduce((n,i)=>n+cents(i.lineTotal),0);let allocated=0;
    items.forEach((it,index)=>{
      const value=index===items.length-1?amount-allocated:Math.round(amount*(total?cents(it.lineTotal)/total:1/items.length));allocated+=value;
      const p=productAgg[it.name] ||= {qty:0,sales:0,isDrink:it.isDrink,sizes:{}};p.sales+=money(value);
      if(quantity){p.qty+=it.qty;if(it.size)p.sizes[it.size]=(p.sizes[it.size]||0)+it.qty;}
    });
  }
  for(const o of paid){
    gross+=cents(o.total);if(o.source==='GrabFood')fees+=Math.round(cents(o.total)*Number(o.grabFeeRate??.25));
    for(const [method,value] of Object.entries(p1Parts(o))){const pm=pmAgg[method] ||= {count:0,sales:0};pm.count++;pm.sales+=value;}
    const src=sourceAgg[o.source||'Walk-in'] ||= {count:0,sales:0,items:0,cups:0,discounts:0};src.count++;src.sales+=o.total;src.discounts+=Number(o.discountAmount)||0;
    const countItems=o.status!=='Cancelled';
    if(countItems)for(const it of o.items){src.items+=it.qty;if(it.isDrink){cups+=it.qty;src.cups+=it.qty;if(it.size in cupBySize)cupBySize[it.size]+=it.qty;}else foodItems+=it.qty;}
    products(o.items,cents(o.total),countItems);
  }
  for(const r of refunds){
    refundCents+=cents(r.amount);
    for(const [method,field] of [['Cash','cash_amount'],['GCash','gcash_amount'],['GrabFood','grab_amount']]){
      const value=Number(r[field]||0);if(value){const pm=pmAgg[method] ||= {count:0,sales:0};pm.sales-=value;}
    }
    const order=p1RefundOrder(r,orders);
    if(order){sourceAgg[order.source||'Walk-in'].sales-=Number(r.amount);products(order.items,-cents(r.amount),false);}
    fees-=Math.round(cents(r.grab_amount)*Number(order?.grabFeeRate??.25));
  }
  for(const p of Object.values(pmAgg))p.sales=money(cents(p.sales));
  const totalSales=money(gross-refundCents),totalTx=paid.length;
  const productsList=Object.entries(productAgg).map(([name,v])=>({name,...v,sales:money(cents(v.sales))})).sort((a,b)=>b.qty-a.qty);
  const cancelled=orders.filter(p1IsCancelled);
  return {refunds,totalSales,grossSales:money(gross),refundTotal:money(refundCents),estimatedFees:money(fees),estimatedProceeds:money(gross-refundCents-fees),totalTx,cups,foodItems,avgOrder:totalTx?totalSales/totalTx:0,cupBySize,products:productsList,pmAgg,sourceAgg,
    bestByQty:productsList[0]||null,bestByRevenue:[...productsList].sort((a,b)=>b.sales-a.sales)[0]||null,bestFood:productsList.filter(p=>!p.isDrink)[0]||null,leastSelling:[...productsList].sort((a,b)=>a.qty-b.qty)[0]||null,popularSize:Object.entries(cupBySize).sort((a,b)=>b[1]-a[1])[0],cancelled,cancelledAmount:cancelled.reduce((n,o)=>n+o.total,0)};
};
shiftFinancialSummary=function(shift,endIso=null){
 const end=endIso||shift.closedAt||new Date().toISOString();
 const orders=ORDERS.filter(o=>o.date===shift.businessDate&&isWithinShift(o.timestamp,shift,end));
 const refunds=p1Refunds(shift.businessDate).filter(r=>isWithinShift(r.created_at,shift,end));
 const m=computeMetrics(orders,refunds),cashSales=m.pmAgg.Cash?.sales||0,gcashSales=m.pmAgg.GCash?.sales||0,grabSales=m.pmAgg.GrabFood?.sales||0;
 const expenses=EXPENSES.filter(x=>x.date===shift.businessDate&&x.status!=='Voided'&&isWithinShift(x.timestamp,shift,end)).reduce((n,x)=>n+x.amount,0);
 const movements=CASH_MOVEMENTS.filter(x=>x.date===shift.businessDate&&x.status!=='Voided'&&isWithinShift(x.timestamp,shift,end));
 const cashIn=movements.filter(x=>x.type==='In').reduce((n,x)=>n+x.amount,0),cashOut=movements.filter(x=>x.type==='Out').reduce((n,x)=>n+x.amount,0);
 return {orders,cashSales,gcashSales,grabSales,expenses,cashIn,cashOut,expected:money(cents(shift.openingCash)+cents(cashSales)+cents(cashIn)-cents(cashOut)-cents(expenses)),transactionCount:m.totalTx,cupsSold:m.cups};
};
// Known existing records use PATCH. An upsert INSERT trigger must not intercept day unlocking.
upsertFinancialRow=async function(table,payload,conflict='id'){
 const lists={daily_expenses:EXPENSES,owner_expenses:OWNER_EXPENSES,cash_movements:CASH_MOVEMENTS};
 const exists=table==='eod_reconciliations'?!!EOD[payload.business_date]:lists[table]?.some(x=>x.id===payload.id);
 const path='/rest/v1/'+table+(exists?'?'+conflict+'=eq.'+encodeURIComponent(payload[conflict]):'');
 const res=await posApi(path,{method:exists?'PATCH':'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
 const rows=await res.json();if(!rows?.length)throw Error('The database did not confirm this change.');return rows[0];
};
function p1WrapRender(name,range,container){
 const original=window[name];
 window[name]=async function(...args){
  if(!CURRENT_USER)return;const busyNode=document.getElementById(container);if(busyNode){busyNode.inert=true;busyNode.setAttribute('aria-busy','true');}const generation=p1RenderVersions[name]=(p1RenderVersions[name]||0)+1;
  try{const [start,end]=range();await p1Load(start,end);if(generation!==p1RenderVersions[name])return;original(...args);p1Decorate(name,start,end);}
  catch(error){const node=document.getElementById(container);if(node)node.innerHTML=`<div class="card" style="padding:24px;"><strong>Report unavailable</strong><p>${esc(error.message)}</p><button class="btn btn-secondary" id="p1-retry-${name}">Retry</button></div>`;document.getElementById('p1-retry-'+name)?.addEventListener('click',()=>window[name](...args));}
  finally{if(busyNode && generation===p1RenderVersions[name]){busyNode.inert=false;busyNode.removeAttribute('aria-busy');}}
 };
}
p1WrapRender('renderDashboard',()=>p1Range(),'dashboard-content');
p1WrapRender('renderReports',()=>reportsView==='monthly'&&isSuperuser()?p1MonthlyRange():p1Range(reportsFilter),'reports-content');
p1WrapRender('renderMonthlyPerformance',p1MonthlyRange,'monthly-performance-content');
p1WrapRender('renderOrdersPage',()=>p1Range(ordersFilter),'orders-table');
p1WrapRender('renderExpensesPage',()=>p1Range(expensesFilter),'expenses-content');
p1WrapRender('renderShiftsPage',()=>[shiftsFilterDate||businessDayKey(),shiftsFilterDate||businessDayKey()],'shifts-content');
function p1Decorate(name,start,end){
 if(name==='renderDashboard')return;
 const target={renderReports:'reports-content',renderMonthlyPerformance:'monthly-performance-content'}[name];
 if(!target)return;
 const el=document.getElementById(target);el.querySelector('.p1-refund-summary')?.remove();
 const refunds=p1RefundedOnly(p1Refunds(start,end));const m=computeMetrics(ORDERS.filter(o=>o.date>=start&&o.date<=end),refunds);
 const panel=document.createElement('div');panel.className='card p1-refund-summary';panel.style.cssText='padding:16px 20px;margin:16px 0;';
 panel.innerHTML=`<div class="section-title">Sales &amp; returns</div><div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px;"><span>Sales before refunds <b>${PESO(m.grossSales)}</b></span><span>Refunded <b>${PESO(m.refundTotal)}</b></span><span>Net sales <b>${PESO(m.totalSales)}</b></span><span>Estimated Grab fees <b>${PESO(m.estimatedFees)}</b></span></div><p style="font-size:11px;color:var(--text-dim);">Refunded totals include ordinary Refund records only. Cancelled orders and their cancellation returns are excluded. Refunds appear on the day money is returned. Grab proceeds are estimates using each order’s saved fee rate; actual settlements may differ. Ingredient costs are not included.</p>${refunds.length?`<details><summary>View ${refunds.length} refunded record(s)</summary><div style="overflow:auto"><table><thead><tr><th>Date</th><th>Order</th><th>Type</th><th>Amount</th><th>Reason</th></tr></thead><tbody>${refunds.map(r=>`<tr><td>${esc(r.business_date)}</td><td>${esc(r.order?.order_code||r.order_id)}</td><td>${esc(r.kind)}</td><td>${PESO(r.amount)}</td><td>${esc(r.reason)}</td></tr>`).join('')}</tbody></table></div></details>`:''}`;
 const anchor=name==='renderMonthlyPerformance'?el.querySelector('.month-total-panel'):el.querySelector('.page-title');
 anchor?.after(panel);
}
async function p1Status(id,status,reason=''){
 const res=await posApi('/rest/v1/rpc/hibi_order_status',{method:'POST',body:JSON.stringify({p_id:id,p_status:status,p_reason:reason})});
 const row=await res.json();const order=ORDERS.find(x=>x.id===id);if(order){order.status=row.status;order.completedAt=row.completed_at;}return row;
}
async function p1RefreshOrderSurface(){
 const active=document.querySelector('nav.tabs button.active')?.dataset.page;
 if(active==='dashboard')await renderDashboard();else await renderOrdersPage();
}
completeOrderFromList=async function(id){
 const o=ORDERS.find(x=>x.id===id);
 if(!o)return;
 if(!isSuperuser()&&(o.status!=='Preparing'||o.date!==businessDayKey()||isDateLocked(o.date))){toast('Cashiers can only complete current-day Preparing orders.');return;}
 try{await p1Status(id,'Completed','Preparation completed');await p1RefreshOrderSurface();toast('Order completed');}catch(e){toast(e.message);}
};
const p1OpenOrderDetail=openOrderDetail;
openOrderDetail=function(id){
 p1OpenOrderDetail(id);const o=ORDERS.find(x=>x.id===id);if(!o)return;
 const selector=document.getElementById('status-select');
 const staffCanComplete=!isSuperuser()&&o.status==='Preparing'&&o.date===businessDayKey()&&!isDateLocked(o.date);
 const allowedStatuses=isSuperuser()?['Preparing','Completed']:(staffCanComplete?['Preparing','Completed']:[o.status]);
 selector.innerHTML=allowedStatuses.map(s=>`<option value="${s}" ${s===o.status?'selected':''}>${s}</option>`).join('');
 selector.disabled=isSuperuser()?(o.status==='Cancelled'||isDateLocked(o.date)):!staffCanComplete;
 const save=document.getElementById('modal-save-status');save.disabled=selector.disabled;save.onclick=async()=>{
  if(!isSuperuser()&&(!staffCanComplete||selector.value!=='Completed')){toast('Cashiers can only complete current-day Preparing orders.');return;}
  const reason=requireActionReason('changing preparation status');if(!reason)return;save.disabled=true;try{await p1Status(id,selector.value,reason);closeModal();await p1RefreshOrderSurface();}catch(e){toast(e.message);save.disabled=false;}
 };
 const body=document.querySelector('#modal-root .modal-body');body.insertAdjacentHTML('beforeend',`<p>Payment: <strong>${esc(o.paymentStatus||'Paid')}</strong></p>`);
 const canRefundOrder=isSuperuser()||(o.date===businessDayKey()&&!isDateLocked(o.date));
 if(canRefundOrder&&o.paymentStatus!=='LegacyCancelled'&&o.paymentStatus!=='Refunded'){
 const button=document.createElement('button');button.className='btn btn-secondary';button.textContent='Refund / Cancel Order';button.onclick=()=>p1RefundModal(o);document.querySelector('#modal-root .modal-foot').prepend(button);
 }
 const history=REFUNDS.filter(r=>r.order_id===o.id);
 if(history.length){
  const host=document.querySelector('#modal-root .modal-body');
  host.insertAdjacentHTML('beforeend',`<div class="card" style="padding:12px;margin-top:14px;"><div class="section-title">Refund history</div>${history.map(r=>`<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;border-top:1px solid var(--line);padding:9px 0;font-size:12px;"><span><strong>${esc(r.kind)}</strong> ${PESO(r.amount)}${r.voided_at?` <span class="badge-inactive">VOIDED</span>`:''}<br><span style="color:var(--text-dim);">${esc(r.reason||'')}</span></span>${!r.voided_at&&isSuperuser()?`<button type="button" class="icon-btn danger" data-void-refund="${escAttr(r.id)}">Void / Correct</button>`:''}</div>`).join('')}</div>`);
  host.querySelectorAll('[data-void-refund]').forEach(b=>b.onclick=()=>p1VoidRefundModal(b.dataset.voidRefund,o));
 }
};
async function p1VoidRefundModal(refundId,o){
 if(!isSuperuser()){toast('Only a superuser can correct or void a refund.');return;}
 openModal(`<div class="modal-head"><h3>Void refund ${esc(o.orderNumber)}</h3></div><div class="modal-body"><p>This keeps the original refund in the audit trail and allows a corrected refund to be entered afterward.</p><div class="field"><label>Reason for correction</label><input id="p1-void-reason" placeholder="e.g. Wrong payment method entered"></div></div><div class="modal-foot"><button class="btn btn-secondary" id="p1-void-close">Close</button><button class="btn btn-danger" id="p1-void-save">Void refund</button></div>`);
 document.getElementById('p1-void-close').onclick=closeModal;
 document.getElementById('p1-void-save').onclick=async()=>{const reason=document.getElementById('p1-void-reason').value.trim();if(!reason){toast('Enter a reason for the correction.');return;}const btn=document.getElementById('p1-void-save');btn.disabled=true;try{await posApi('/rest/v1/rpc/hibi_void_refund',{method:'POST',body:JSON.stringify({p_request_id:crypto.randomUUID(),p_refund_id:refundId,p_reason:reason})});closeModal();await p1Load(o.date,o.date,true);await p1Load(businessDayKey(),businessDayKey(),true);await renderOrdersPage();toast('Refund voided. Enter the corrected refund.');}catch(e){toast(e.message);btn.disabled=false;}};
}
async function p1RefundModal(o){
 const payloadId=crypto.randomUUID();
 const canCancel=o.date===businessDayKey()&&(o.status==='New'||o.status==='Preparing');
 openModal(`<div class="modal-head"><h3>Refund / Cancel ${esc(o.orderNumber)}</h3></div><div class="modal-body"><p>Use <strong>Refund</strong> for a partial or completed-order return.${canCancel?' Use <strong>Cancellation</strong> to return the full remaining payment automatically.':''}</p><div class="field"><label>Action</label><select id="p1-kind"><option>Refund</option>${canCancel?'<option>Cancellation</option>':''}</select></div><div id="p1-amount-fields">${[['cash','Cash'],['gcash','GCash'],['grab','GrabFood']].map(([id,label])=>`<div class="field"><label>${label} refund</label><input id="p1-${id}" type="number" min="0" step="0.01" value="0"></div>`).join('')}</div><div id="p1-cancel-note" style="display:none;padding:10px 12px;border-radius:9px;background:#EEF2E4;color:#35563B;font-size:12px;margin-bottom:14px;">Cancellation will automatically return the full remaining payment. No amount entry is needed.</div><div class="field"><label>Was preparation started?</label><select id="p1-prepared"><option value="">Select...</option><option value="true">Yes - ingredients may have been used</option><option value="false">No - preparation not started</option></select></div><div class="field"><label>Reason</label><input id="p1-reason" placeholder="Required"></div><p style="font-size:12px">Cashiers can process current-day orders only. Refunds do not restore ingredients. Refund corrections remain superuser-only.</p></div><div class="modal-foot"><button id="p1-refund-close" class="btn btn-secondary">Close</button><button id="p1-refund-save" class="btn btn-primary">Record Refund</button></div>`);
 const kindSelect=document.getElementById('p1-kind');
 const syncAmounts=()=>{const cancelling=kindSelect.value==='Cancellation',remaining=p1RemainingParts(o);document.getElementById('p1-cancel-note').style.display=cancelling?'block':'none';document.getElementById('p1-amount-fields').style.display=cancelling?'none':'';document.getElementById('p1-refund-save').textContent=cancelling?'Cancel & Refund Full Amount':'Record Refund';for(const [id,method] of [['cash','Cash'],['gcash','GCash'],['grab','GrabFood']]){const input=document.getElementById('p1-'+id);if(cancelling)input.value=(remaining[method]||0).toFixed(2);input.readOnly=cancelling;input.style.background=cancelling?'#EEF2E4':'';}};
 kindSelect.onchange=syncAmounts;syncAmounts();
 document.getElementById('p1-refund-close').onclick=closeModal;
 let pending=null;const button=document.getElementById('p1-refund-save');
 button.onclick=async()=>{
  if(!pending){const reason=document.getElementById('p1-reason').value.trim(),prepared=document.getElementById('p1-prepared').value;if(!reason||!prepared){toast('Select preparation state and enter a reason.');return;}
  pending={p_request_id:payloadId,p_order_id:o.id,p_cash:Number(document.getElementById('p1-cash').value),p_gcash:Number(document.getElementById('p1-gcash').value),p_grab:Number(document.getElementById('p1-grab').value),p_kind:document.getElementById('p1-kind').value,p_prepared:prepared==='true',p_reason:reason};}
  button.disabled=true;
  try{await posApi('/rest/v1/rpc/hibi_refund',{method:'POST',body:JSON.stringify(pending)});await p1Load(o.date,o.date,true);await p1Load(businessDayKey(),businessDayKey(),true);closeModal();await p1RefreshOrderSurface();toast(pending.p_kind==='Cancellation'?'Order cancelled and fully refunded.':'Refund recorded.');}
  catch(e){toast(e.message);button.textContent='Retry same refund';}finally{button.disabled=false;}
 };
}
// A request survives refresh in this browser tab. Never create a new ID after an uncertain save.
function p1PendingKey(){return 'hibi-pending-order:'+CURRENT_USER.id;}
async function p1Submit(payload){
 let pending=JSON.parse(sessionStorage.getItem(p1PendingKey())||'null');
 if(pending){throw Error('An earlier order needs checking. Use Check pending order before taking another payment.');}
 pending={id:crypto.randomUUID(),payload};sessionStorage.setItem(p1PendingKey(),JSON.stringify(pending));
 const res=await posApi('/rest/v1/rpc/hibi_create_order_v2',{method:'POST',body:JSON.stringify({p_request_id:pending.id,p_payload:pending.payload})});
 const order=await res.json();if(!order?.id)throw Error('Order confirmation is missing. Check the pending order.');
 sessionStorage.removeItem(p1PendingKey());return order;
}
async function p1RecoverOrder(){
 const pending=JSON.parse(sessionStorage.getItem(p1PendingKey())||'null');if(!pending)return;
 const button=document.getElementById('p1-pending-retry');if(button)button.disabled=true;
 try{const res=await posApi('/rest/v1/rpc/hibi_create_order_v2',{method:'POST',body:JSON.stringify({p_request_id:pending.id,p_payload:pending.payload})});const row=await res.json();if(!row?.id)throw Error('No order confirmation');sessionStorage.removeItem(p1PendingKey());CART=[];renderCart();await p1Load(row.order_date,row.order_date,true);goToPage('dashboard');toast('Order confirmed: '+row.order_code);}
 catch(e){toast(e.message);}finally{if(button)button.disabled=false;}
}
const p1RenderPOS=renderPOS;
renderPOS=function(){p1RenderPOS();document.getElementById('p1-pending-banner')?.remove();if(!CURRENT_USER)return;const pending=sessionStorage.getItem(p1PendingKey());if(!pending)return;const node=document.createElement('div');node.id='p1-pending-banner';node.className='card';node.style.cssText='padding:14px;margin:12px;border:2px solid #B8763E';node.innerHTML='<strong>An order needs confirmation</strong><p>Check this order before taking another payment. Retrying uses the same submission reference.</p><button class="btn btn-primary" id="p1-pending-retry">Check pending order</button>';document.getElementById('page-pos').prepend(node);document.getElementById('p1-pending-retry').onclick=p1RecoverOrder;};
const p1Settings=renderSettings;
renderSettings=function(){p1Settings();if(!isSuperuser())return;const el=document.getElementById('settings-content');el.insertAdjacentHTML('beforeend',`<div class="card" style="padding:20px;margin-top:16px;"><div class="section-title">GrabFood fee estimate</div><p>Changes apply to newly entered orders for the effective date onward. Existing order rates are preserved.</p><div class="field"><label>Effective date</label><input type="date" id="p1-fee-date" value="${businessDayKey()}" min="${businessDayKey()}"></div><div class="field"><label>Estimated deduction (%)</label><input type="number" min="0" max="100" step="0.01" id="p1-fee-rate" value="${100*(FEE_RATES.filter(r=>r.effective_date<=businessDayKey()).at(-1)?.rate??.25)}"></div><button class="btn btn-primary" id="p1-fee-save">Save estimate</button></div><div class="card" style="padding:20px;margin-top:16px;"><div class="section-title">Backups</div><p>Use the database backup and restore instructions included with Phase 1. Sales spreadsheets are reports, not complete database backups.</p></div>`);
 document.getElementById('p1-fee-save').onclick=async()=>{try{await posApi('/rest/v1/rpc/hibi_set_fee',{method:'POST',body:JSON.stringify({p_date:document.getElementById('p1-fee-date').value,p_rate:Number(document.getElementById('p1-fee-rate').value)/100})});await p1Load(businessDayKey(),businessDayKey(),true);toast('Fee estimate saved');}catch(e){toast(e.message);}};
};

const p1OrderTableRows=orderTableRows;
orderTableRows=function(o){return p1OrderTableRows(o).replace(`<td class="num">${PESO(o.total)}</td>`,`<td class="num">${PESO(o.total)}<div style="font-size:11px;color:var(--text-dim);">${esc(o.paymentStatus||'Paid')}</div></td>`);};
async function p1DownloadBackup(){
 if(!isSuperuser())return;
 const button=document.getElementById('p1-backup');if(button)button.disabled=true;
 try{
  const res=await posApi('/rest/v1/rpc/hibi_backup',{method:'POST',body:'{}'});
  const data=await res.json();if(data.format!=='hibi-application-backup-v1')throw Error('Invalid backup response');
  const payload=JSON.stringify(data),hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
  const sha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  const url=URL.createObjectURL(new Blob([JSON.stringify({sha256,payload})],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='hibi-backup-'+businessDayKey()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Application backup downloaded');
 }catch(e){toast(e.message);}finally{if(button)button.disabled=false;}
}
const p1SettingsWithFees=renderSettings;
renderSettings=function(){p1SettingsWithFees();if(!isSuperuser())return;const el=document.getElementById('settings-content');el.insertAdjacentHTML('beforeend','<div class="card" style="padding:20px;margin-top:16px;"><button class="btn btn-primary" id="p1-backup">Download Application Backup</button><p>Includes POS records, settings, accounts, refunds and audit history. Does not include login credentials, image files or server email functions. Keep this download private and save those assets separately.</p></div>');document.getElementById('p1-backup').onclick=p1DownloadBackup;};
// Check/close an unresolved request under the same database lock as its write.
// A not-saved result leaves a tombstone so a delayed original request cannot post later.
async function p1Resolve(id){const res=await posApi('/rest/v1/rpc/hibi_resolve_request',{method:'POST',body:JSON.stringify({p_request_id:id})});return res.json();}
function p1RefundKey(){return 'hibi-pending-refund:'+CURRENT_USER.id;}
const p1RefundForm=p1RefundModal;
p1RefundModal=async function(o){
 const old=JSON.parse(sessionStorage.getItem(p1RefundKey())||'null');
 if(old){await p1CheckRefund();return;}
 await p1RefundForm(o);
 const button=document.getElementById('p1-refund-save');
 // Replace the form's handler with a persistent, immutable submission.
 button.onclick=async()=>{
  const reason=document.getElementById('p1-reason').value.trim(),prepared=document.getElementById('p1-prepared').value;
  if(!reason||!prepared){toast('Select preparation state and enter a reason.');return;}
  const kind=document.getElementById('p1-kind').value,remaining=p1RemainingParts(o);
  const payload={p_request_id:crypto.randomUUID(),p_order_id:o.id,p_cash:kind==='Cancellation'?remaining.Cash:Number(document.getElementById('p1-cash').value),p_gcash:kind==='Cancellation'?remaining.GCash:Number(document.getElementById('p1-gcash').value),p_grab:kind==='Cancellation'?remaining.GrabFood:Number(document.getElementById('p1-grab').value),p_kind:kind,p_prepared:prepared==='true',p_reason:reason};
  sessionStorage.setItem(p1RefundKey(),JSON.stringify(payload));button.disabled=true;
  try{
   await posApi('/rest/v1/rpc/hibi_refund',{method:'POST',body:JSON.stringify(payload)});
   sessionStorage.removeItem(p1RefundKey());closeModal();await p1Load(o.date,o.date,true);await p1Load(businessDayKey(),businessDayKey(),true);await p1RefreshOrderSurface();toast(kind==='Cancellation'?'Order cancelled and fully refunded.':'Refund recorded.');
  }catch(e){button.textContent='Check refund result';button.onclick=p1CheckRefund;toast('Check the refund result before issuing another refund. '+e.message);}
  finally{button.disabled=false;}
 };
};
async function p1CheckRefund(){
 const payload=JSON.parse(sessionStorage.getItem(p1RefundKey())||'null');if(!payload)return;
 try{const result=await p1Resolve(payload.p_request_id);sessionStorage.removeItem(p1RefundKey());closeModal();await p1Load(businessDayKey(),businessDayKey(),true);await p1RefreshOrderSurface();toast(result.state==='saved'?'The refund was already recorded.':'The refund was not saved. You can enter it again.');}catch(e){toast(e.message);}
}
p1RecoverOrder=async function(){
 const pending=JSON.parse(sessionStorage.getItem(p1PendingKey())||'null');if(!pending)return;
 const button=document.getElementById('p1-pending-retry');if(button)button.disabled=true;
 try{const result=await p1Resolve(pending.id);sessionStorage.removeItem(p1PendingKey());
  if(result.state==='saved'){
   const row=result.result;CART=[];renderCart();await p1Load(row.order_date,row.order_date,true);goToPage('dashboard');toast('Order was already saved: '+row.order_code);
  }else{toast('The order was not saved. Check the cart and submit again.');}
  renderPOS();
 }catch(e){toast(e.message);}finally{if(button)button.disabled=false;}
};
const p1OrdersWithData=renderOrdersPage;
renderOrdersPage=async function(){await p1OrdersWithData();document.getElementById('p1-refund-pending')?.remove();if(sessionStorage.getItem(p1RefundKey())){const button=document.createElement('button');button.id='p1-refund-pending';button.className='btn btn-secondary';button.textContent='Check pending refund';button.onclick=p1CheckRefund;document.getElementById('orders-filter').prepend(button);}};
