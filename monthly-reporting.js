/* ============================================================
   Monthly reporting v2: month-end workbook + email automation
   ============================================================ */
const MONTHLY_REPORT_FUNCTION='monthly-report';
function p2EffectiveDiscount(o){return Math.max(Number(o.discountAmount)||0,Math.max(0,(Number(o.subtotal)||0)-(Number(o.total)||0)));}
function p2DiscountClass(o){
 const raw=String(o.discountType||'').trim();
 if(raw && raw.toLowerCase()!=='none'){
  const t=raw.toLowerCase();
  if(t.includes('loyalty'))return 'Loyalty Rewards';
  if(t.includes('pwd')||t.includes('senior'))return 'PWD / Senior';
  return 'Unclassified Recorded Discount';
 }
 const code=String(o.orderNumber||'');
 if(['HIBI-0998','HIBI-1010'].includes(code))return 'Loyalty Rewards';
 return p2EffectiveDiscount(o)>0?'Unclassified Recorded Discount':'None';
}
function p2Money(n){return PESO(Math.round((Number(n)||0)*100)/100);}
function p2MonthData(ym){
 const {start,end,days}=monthDateRange(ym);
 const orders=ORDERS.filter(o=>o.date>=start&&o.date<=end);
 const paid=orders.filter(o=>!p1IsCancelled(o));
 const refunds=p1RefundedOnly(p1Refunds(start,end),orders);
 const m=computeMetrics(orders,refunds);
 const dailyExpenses=EXPENSES.filter(x=>x.date>=start&&x.date<=end&&x.status!=='Voided');
 const opexRows=OWNER_EXPENSES.filter(x=>x.date>=start&&x.date<=end&&x.status!=='Voided');
 const movements=CASH_MOVEMENTS.filter(x=>x.date>=start&&x.date<=end&&x.status!=='Voided');
 const dailyExpensesTotal=dailyExpenses.reduce((n,x)=>n+Number(x.amount||0),0);
 const opexTotal=opexRows.reduce((n,x)=>n+Number(x.amount||0),0);
 const cashIn=movements.filter(x=>x.type==='In').reduce((n,x)=>n+Number(x.amount||0),0);
 const cashOut=movements.filter(x=>x.type==='Out').reduce((n,x)=>n+Number(x.amount||0),0);
 const grossSales=paid.reduce((n,o)=>n+Number(o.subtotal||0),0);
 const discountTotal=paid.reduce((n,o)=>n+p2EffectiveDiscount(o),0);
 const trackedCosts=dailyExpensesTotal+opexTotal+Number(m.estimatedFees||0);
 const netAfterTracked=Number(m.totalSales||0)-trackedCosts;
 const discounts={};
 paid.forEach(o=>{const amt=p2EffectiveDiscount(o);if(amt<=0)return;const c=p2DiscountClass(o);const x=discounts[c]||{orders:0,amount:0};x.orders++;x.amount+=amt;discounts[c]=x;});
 const daily=[];
 for(let d=1;d<=days;d++){
  const dateKey=`${ym}-${String(d).padStart(2,'0')}`;
  const dayOrders=ORDERS.filter(o=>o.date===dateKey);
  const dayPaid=dayOrders.filter(o=>!p1IsCancelled(o));
  const dm=computeMetrics(dayOrders,p1Refunds(dateKey));
  const exp=dailyExpenses.filter(x=>x.date===dateKey).reduce((n,x)=>n+Number(x.amount||0),0);
  const opex=opexRows.filter(x=>x.date===dateKey).reduce((n,x)=>n+Number(x.amount||0),0);
  const dayMoves=movements.filter(x=>x.date===dateKey);
  const ci=dayMoves.filter(x=>x.type==='In').reduce((n,x)=>n+Number(x.amount||0),0);
  const co=dayMoves.filter(x=>x.type==='Out').reduce((n,x)=>n+Number(x.amount||0),0);
  const gross=dayPaid.reduce((n,o)=>n+Number(o.subtotal||0),0);
  const disc=dayPaid.reduce((n,o)=>n+p2EffectiveDiscount(o),0);
  daily.push({dateKey,transactions:dm.totalTx,cups:dm.cups,foodItems:dm.foodItems,gross,discounts:disc,salesAfterDiscounts:dm.grossSales,refunds:dm.refundTotal,netSales:dm.totalSales,cash:dm.pmAgg.Cash?.sales||0,gcash:dm.pmAgg.GCash?.sales||0,grab:dm.pmAgg.GrabFood?.sales||0,cashIn:ci,cashOut:co,dailyExpenses:exp,opex,netAfterTracked:dm.totalSales-exp-opex-dm.estimatedFees});
 }
 return {ym,start,end,orders,paid,m,grossSales,discountTotal,dailyExpensesTotal,opexTotal,trackedCosts,netAfterTracked,cashIn,cashOut,discounts,daily,activeDays:new Set(paid.map(o=>o.date)).size};
}
async function p2MonthlyApi(mode,ym){
 let token=CURRENT_USER?.access_token||'';
 try{const {data}=await supabaseClient.auth.getSession();token=data?.session?.access_token||token;}catch(_e){}
 if(!token)throw Error('Please sign in again.');
 const res=await fetch(`${SUPABASE_URL}/functions/v1/${MONTHLY_REPORT_FUNCTION}`,{method:'POST',headers:{'Content-Type':'application/json',apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`},body:JSON.stringify({mode,reportMonth:ym})});
 const data=await res.json().catch(()=>({}));if(!res.ok)throw Error(data.error||`Monthly report request failed (${res.status}).`);return data;
}
function p2DownloadBase64(attachment){
 if(!attachment?.content)throw Error('The report attachment was not returned.');
 const binary=atob(attachment.content),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
 const a=document.createElement('a');a.href=url;a.download=attachment.filename||'Hibi-Monthly-Report.xlsx';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function p2LoadMonthlySettings(){
 const res=await posApi('/rest/v1/monthly_report_settings?select=*&id=eq.1&limit=1');const rows=await res.json();return rows?.[0]||{automatic_enabled:true,recipients:[]};
}
async function p2LoadMonthlyHistory(ym){
 const res=await posApi(`/rest/v1/monthly_report_log?select=id,report_month,trigger_type,status,recipients,filename,error_message,created_at,sent_at&report_month=eq.${encodeURIComponent(ym)}&order=created_at.desc&limit=8`);return await res.json();
}
async function p2RenderMonthlyHistory(ym){
 const host=document.getElementById('monthly-report-history');if(!host)return;
 try{
  const [cfg,rows]=await Promise.all([p2LoadMonthlySettings(),p2LoadMonthlyHistory(ym)]);
  const last=rows.find(x=>x.status==='sent');
  host.innerHTML=`<div class="card" style="padding:18px 20px;margin-top:16px;"><div class="section-title">Monthly Report Delivery</div><div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--text-dim);margin-bottom:12px;"><span>Automatic email: <strong style="color:var(--espresso);">${cfg.automatic_enabled?'ON':'OFF'}</strong></span><span>Recipients: <strong style="color:var(--espresso);">${esc((cfg.recipients||[]).join(', ')||'Not configured')}</strong></span><span>Last sent: <strong style="color:var(--espresso);">${last?esc(new Date(last.sent_at||last.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'})):'—'}</strong></span></div><div style="overflow:auto"><table><thead><tr><th>Generated</th><th>Trigger</th><th>Status</th><th>File</th></tr></thead><tbody>${rows.length?rows.map(x=>`<tr><td>${esc(new Date(x.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}))}</td><td>${esc(x.trigger_type)}</td><td>${esc(x.status)}</td><td>${esc(x.filename||x.error_message||'—')}</td></tr>`).join(''):'<tr><td colspan="4">No report activity for this month yet.</td></tr>'}</tbody></table></div></div>`;
 }catch(e){host.innerHTML=`<div class="card" style="padding:16px;margin-top:16px;color:var(--rust);">Could not load monthly report delivery history: ${esc(e.message)}</div>`;}
}
renderMonthlyPerformance=async function(){
 if(!isSuperuser())return;
 const el=document.getElementById('monthly-performance-content');
 const ym=monthlyPerformanceMonth||businessDayKey().slice(0,7);const {start,end}=monthDateRange(ym);
 el.innerHTML='<div class="card" style="padding:24px;">Loading monthly performance…</div>';
 try{await p1Load(start,end);const x=p2MonthData(ym),m=x.m;const totalCash=m.pmAgg.Cash?.sales||0,totalGcash=m.pmAgg.GCash?.sales||0,totalGrab=m.pmAgg.GrabFood?.sales||0;
 const topQty=m.bestByQty,topRev=m.bestByRevenue;const discountEntries=Object.entries(x.discounts).sort((a,b)=>b[1].amount-a[1].amount);
 el.innerHTML=`<div class="page-title"><div><h1>Monthly Performance</h1><div class="psub">Business performance for ${esc(formatMonthLabel(ym))}</div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><input type="month" id="monthly-performance-month" value="${escAttr(ym)}" max="${businessDayKey().slice(0,7)}"><button class="btn btn-secondary" id="monthly-download-btn">Download Excel</button><button class="btn btn-primary" id="monthly-email-btn">Generate &amp; Email Report</button></div></div>
 <section class="month-total-panel"><div class="month-total-heading"><div><div class="month-total-eyebrow">MONTH TOTAL</div><h2>${esc(formatMonthLabel(ym))}</h2><p>All recorded activity for the selected month</p></div><div class="month-total-net"><span>Net After Tracked Expenses</span><strong>${p2Money(x.netAfterTracked)}</strong><small>Net sales less all tracked expenses &amp; charges</small></div></div><div class="month-total-metrics"><div><span>Gross Sales</span><strong>${p2Money(x.grossSales)}</strong></div><div><span>Discounts</span><strong>${p2Money(x.discountTotal)}</strong></div><div><span>Net Sales</span><strong>${p2Money(m.totalSales)}</strong></div><div><span>Transactions</span><strong>${m.totalTx}</strong></div><div><span>Cups Sold</span><strong>${m.cups}</strong></div><div><span>Avg Order</span><strong>${p2Money(m.avgOrder)}</strong></div><div><span>Tracked Expenses &amp; Charges</span><strong>${p2Money(x.trackedCosts)}</strong></div><div><span>Cash In</span><strong>${p2Money(x.cashIn)}</strong></div><div><span>Cash Out</span><strong>${p2Money(x.cashOut)}</strong></div></div></section>
 <div class="two-col" style="grid-template-columns:1.1fr .9fr;gap:16px;margin-top:16px;"><div class="card" style="padding:18px 20px;"><div class="section-title">Sales Waterfall</div><table><tbody><tr><td>Gross Sales</td><td class="num">${p2Money(x.grossSales)}</td></tr><tr><td>Less: Discounts</td><td class="num">− ${p2Money(x.discountTotal)}</td></tr><tr><td>Sales After Discounts</td><td class="num">${p2Money(m.grossSales)}</td></tr><tr><td>Less: Refunds</td><td class="num">− ${p2Money(m.refundTotal)}</td></tr><tr class="total-row"><td>Net Sales</td><td class="num">${p2Money(m.totalSales)}</td></tr><tr class="total-row"><td>Net After Tracked Expenses</td><td class="num">${p2Money(x.netAfterTracked)}</td></tr></tbody></table></div><div class="card" style="padding:18px 20px;"><div class="section-title">Payment Breakdown</div><table><thead><tr><th>Method</th><th class="num">Sales</th><th class="num">Share</th></tr></thead><tbody>${[['Cash',totalCash],['GCash',totalGcash],['GrabFood',totalGrab]].map(([n,v])=>`<tr><td>${n}</td><td class="num">${p2Money(v)}</td><td class="num">${m.totalSales?((v/m.totalSales)*100).toFixed(2):'0.00'}%</td></tr>`).join('')}</tbody></table></div></div>
 <div class="two-col" style="grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;"><div class="card" style="padding:18px 20px;"><div class="section-title">Discount Breakdown</div><table><thead><tr><th>Type</th><th class="num">Orders</th><th class="num">Amount</th></tr></thead><tbody>${discountEntries.length?discountEntries.map(([n,v])=>`<tr><td>${esc(n)}</td><td class="num">${v.orders}</td><td class="num">${p2Money(v.amount)}</td></tr>`).join(''):'<tr><td colspan="3">No discounts recorded.</td></tr>'}<tr class="total-row"><td>Total</td><td></td><td class="num">${p2Money(x.discountTotal)}</td></tr></tbody></table></div><div class="card" style="padding:18px 20px;"><div class="section-title">Key Insights</div><table><tbody><tr><td>Top-selling product</td><td class="num">${topQty?esc(topQty.name)+' · '+topQty.qty:'—'}</td></tr><tr><td>Highest-revenue product</td><td class="num">${topRev?esc(topRev.name)+' · '+p2Money(topRev.sales):'—'}</td></tr><tr><td>Days with sales</td><td class="num">${x.activeDays}</td></tr><tr><td>Average daily net sales</td><td class="num">${p2Money(x.activeDays?m.totalSales/x.activeDays:0)}</td></tr><tr><td>Average cups / active day</td><td class="num">${x.activeDays?(m.cups/x.activeDays).toFixed(2):'0.00'}</td></tr></tbody></table></div></div>
 <details class="card" style="padding:0;margin-top:16px;overflow-x:auto;" open><summary style="cursor:pointer;padding:18px 20px;"><span class="section-title" style="display:inline;margin:0;">Daily Breakdown</span></summary><div style="padding:0 20px 18px;"><table style="min-width:1500px"><thead><tr><th>Date</th><th class="num">Tx</th><th class="num">Cups</th><th class="num">Gross</th><th class="num">Discounts</th><th class="num">Net Sales</th><th class="num">Cash</th><th class="num">GCash</th><th class="num">GrabFood</th><th class="num">Cash In</th><th class="num">Cash Out</th><th class="num">Daily Exp.</th><th class="num">OPEX</th><th class="num">Net After Tracked</th></tr></thead><tbody>${x.daily.map(r=>`<tr><td>${r.dateKey}</td><td class="num">${r.transactions}</td><td class="num">${r.cups}</td><td class="num">${p2Money(r.gross)}</td><td class="num">${p2Money(r.discounts)}</td><td class="num">${p2Money(r.netSales)}</td><td class="num">${p2Money(r.cash)}</td><td class="num">${p2Money(r.gcash)}</td><td class="num">${p2Money(r.grab)}</td><td class="num">${p2Money(r.cashIn)}</td><td class="num">${p2Money(r.cashOut)}</td><td class="num">${p2Money(r.dailyExpenses)}</td><td class="num">${p2Money(r.opex)}</td><td class="num" style="font-weight:700;${r.netAfterTracked<0?'color:var(--rust);':''}">${p2Money(r.netAfterTracked)}</td></tr>`).join('')}</tbody></table></div></details><div id="monthly-report-history"></div>`;
 const monthInput=el.querySelector('#monthly-performance-month');monthInput.onchange=async e=>{monthlyPerformanceMonth=e.target.value||businessDayKey().slice(0,7);await renderMonthlyPerformance();};
 const download=el.querySelector('#monthly-download-btn');download.onclick=async()=>{download.disabled=true;const old=download.textContent;download.textContent='Generating…';try{const r=await p2MonthlyApi('download',ym);p2DownloadBase64(r.attachment);toast('Monthly report downloaded.');await p2RenderMonthlyHistory(ym);}catch(e){toast(e.message);}finally{download.disabled=false;download.textContent=old;}};
 const email=el.querySelector('#monthly-email-btn');email.onclick=async()=>{if(!confirm(`Generate and email the ${formatMonthLabel(ym)} monthly report now?`))return;email.disabled=true;const old=email.textContent;email.textContent='Generating & Sending…';try{const r=await p2MonthlyApi('manual',ym);toast(`Monthly report sent to ${(r.sentTo||[]).join(', ')}.`);await p2RenderMonthlyHistory(ym);}catch(e){toast(e.message);}finally{email.disabled=false;email.textContent=old;}};
 p2RenderMonthlyHistory(ym);
 }catch(e){el.innerHTML=`<div class="card" style="padding:24px;"><strong>Monthly report unavailable</strong><p>${esc(e.message)}</p><button class="btn btn-secondary" id="monthly-retry">Retry</button></div>`;document.getElementById('monthly-retry').onclick=renderMonthlyPerformance;}
};

const p2SettingsBase=renderSettings;
renderSettings=function(){
 p2SettingsBase();if(!isSuperuser())return;
 const el=document.getElementById('settings-content');const card=document.createElement('div');card.className='card';card.style.cssText='padding:20px;margin-top:16px;';card.innerHTML=`<div class="section-title">Monthly Report Email</div><p class="permission-note">Automatically sends the completed prior-month report shortly after midnight on the 1st (Asia/Manila). Manual sending is also available from Monthly Performance.</p><div class="field"><label>Automatic month-end email</label><select id="monthly-auto-enabled"><option value="true">On</option><option value="false">Off</option></select></div><div class="field"><label>Recipient email(s)</label><input id="monthly-recipients" type="text" placeholder="owner@example.com, accountant@example.com"><div class="permission-note">Separate multiple addresses with commas.</div></div><button class="btn btn-primary" id="monthly-settings-save">Save Monthly Report Settings</button><div id="monthly-settings-status" class="permission-note" style="margin-top:10px;">Loading…</div>`;el.insertAdjacentElement('beforeend',card);
 (async()=>{try{const cfg=await p2LoadMonthlySettings();document.getElementById('monthly-auto-enabled').value=String(cfg.automatic_enabled!==false);document.getElementById('monthly-recipients').value=(cfg.recipients||[]).join(', ');document.getElementById('monthly-settings-status').textContent='Schedule: 12:20 AM Manila time on the 1st of each month.';}catch(e){document.getElementById('monthly-settings-status').textContent='Could not load monthly report settings: '+e.message;}})();
 document.getElementById('monthly-settings-save').onclick=async()=>{const recipients=document.getElementById('monthly-recipients').value.split(',').map(x=>x.trim()).filter(Boolean);if(!recipients.length){toast('Enter at least one recipient email.');return;}if(recipients.some(x=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))){toast('Check the recipient email address format.');return;}const btn=document.getElementById('monthly-settings-save');btn.disabled=true;try{const res=await posApi('/rest/v1/monthly_report_settings?id=eq.1',{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({automatic_enabled:document.getElementById('monthly-auto-enabled').value==='true',recipients,timezone:'Asia/Manila',updated_at:new Date().toISOString(),updated_by:CURRENT_USER.id})});const rows=await res.json();if(!rows?.length)throw Error('Settings were not saved.');await writeAudit('update_monthly_report_settings','settings','monthly-report','Monthly report settings updated',{automaticEnabled:rows[0].automatic_enabled,recipients});toast('Monthly report settings saved.');document.getElementById('monthly-settings-status').textContent='Saved. Schedule: 12:20 AM Manila time on the 1st of each month.';}catch(e){toast(e.message);}finally{btn.disabled=false;}};
};
