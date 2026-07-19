import { SQLITE_CORE, SQLITE_EXPLORER, unwrapSqliteResponse, type ConnectionSnapshot, type SelectionSnapshot } from '@itharbors/sqlite-contracts';

type Context={message:{request(plugin:string,method:string,input?:unknown):Promise<unknown>}};
type Column={name:string;type:string;notNull:boolean;primaryKeyOrder:number;defaultValue:string|null;hidden:boolean;generated:boolean};
type Index={name:string;unique:boolean;origin:string;partial:boolean;columns:string[]};
type ForeignKey={table:string;from:string;to:string|null;onUpdate:string;onDelete:string};
type Trigger={name:string;sql:string};
type Schema={name:string;kind?:string;type:string;writable:boolean;readOnlyReason?:string|null;sql:string;columns:Column[];primaryKey:string[];indexes:Index[];foreignKeys?:ForeignKey[];triggers?:Trigger[];hasRowid:boolean};

let context:Context|undefined; let root:HTMLElement|null=null; let connection:ConnectionSnapshot|null=null;
let selection:SelectionSnapshot={connectionRevision:0,objectName:null}; let schema:Schema|null=null; let error:string|null=null; let sequence=0; let wrap=true;

const definition={
  async mount(ctx:Context){context=ctx;root=document.querySelector('#panel-root');if(!root)throw new Error('Panel root element #panel-root not found');reset();render();const current=++sequence;try{const [c,s]=await Promise.all([core<ConnectionSnapshot>('getConnectionState'),explorer<SelectionSnapshot>('getSelection')]);if(current!==sequence)return;connection=c;selection=s.connectionRevision===c.connectionRevision?s:{connectionRevision:c.connectionRevision,objectName:null};await load();}catch(e){if(current===sequence)setError(e);}},
  unmount(){sequence++;root?.replaceChildren();root=null;context=undefined;reset();},
  methods:{
    async onConnectionChanged(value:unknown){if(!isConnection(value))return;connection=value;selection={connectionRevision:value.connectionRevision,objectName:null};schema=null;sequence++;render();},
    async onSelectionChanged(value:unknown){if(!isSelection(value)||value.connectionRevision!==connection?.connectionRevision)return;selection=value;schema=null;await load();},
    async onSchemaChanged(value:unknown){if(!isRevision(value)||value.connectionRevision!==connection?.connectionRevision)return;await load();},
  },
};
export default definition;

function reset(){connection=null;selection={connectionRevision:0,objectName:null};schema=null;error=null;wrap=true;sequence++;}
async function load(){const name=selection.objectName;if(!connection?.connected||!name){schema=null;render();return;}const current=++sequence;render();try{const next=await core<Schema>('getObjectSchema',{name});if(current!==sequence||selection.objectName!==name)return;schema=next;error=null;}catch(e){if(current!==sequence)return;setError(e,false);}render();}
async function core<T>(method:string,input?:unknown):Promise<T>{if(!context)throw new Error('Schema Panel 尚未挂载');return unwrapSqliteResponse<T>(await context.message.request(SQLITE_CORE,method,input));}
async function explorer<T>(method:string):Promise<T>{if(!context)throw new Error('Schema Panel 尚未挂载');return context.message.request(SQLITE_EXPLORER,method) as Promise<T>;}
function render(){if(!root)return;if(error){root.innerHTML=`<main class="shell"><div class="error" role="alert">${escape(error)}</div></main>`;return;}if(!connection?.connected||!selection.objectName){root.innerHTML='<main class="empty">请先连接数据库并选择对象。</main>';return;}if(!schema){root.innerHTML=`<main class="empty">正在加载 ${escape(selection.objectName)} 的结构…</main>`;return;}
  root.innerHTML=`<main class="shell"><header class="heading"><div><small>${escape(schema.kind??schema.type)}</small><h1>${escape(schema.name)}</h1></div><button type="button" data-action="toggle-wrap">${wrap?'不换行':'自动换行'}</button></header><div class="grid"><section class="card"><h2>字段</h2>${table(['名称','类型','约束'],schema.columns.map(c=>[c.name,c.type,[c.primaryKeyOrder?'主键':'',c.notNull?'非空':'',c.generated?'生成列':''].filter(Boolean).join(' · ')]))}</section><section class="card"><h2>索引</h2>${table(['名称','列','属性'],schema.indexes.map(i=>[i.name,i.columns.join(', '),[i.unique?'唯一':'',i.partial?'部分':'',i.origin].filter(Boolean).join(' · ')]))}</section><section class="card"><h2>外键</h2>${table(['字段','目标','动作'],(schema.foreignKeys??[]).map(f=>[f.from,`${f.table}.${f.to??''}`,`更新 ${f.onUpdate} · 删除 ${f.onDelete}`]))}</section><section class="card"><h2>触发器</h2>${(schema.triggers??[]).map(t=>`<details><summary>${escape(t.name)}</summary><pre>${escape(t.sql)}</pre></details>`).join('')||'<p>无</p>'}</section><section class="card" style="grid-column:1/-1"><h2>DDL</h2><pre class="ddl ${wrap?'':'nowrap'}"></pre></section></div></main>`;
  root.querySelector('.ddl')!.textContent=schema.sql;root.querySelector('[data-action="toggle-wrap"]')?.addEventListener('click',()=>{wrap=!wrap;render();});}
function table(head:string[],rows:string[][]){return rows.length?`<table><thead><tr>${head.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:'<p>无</p>';}
function setError(value:unknown,rerender=true){error=value instanceof Error?value.message:String(value);if(rerender)render();}
function isRevision(v:unknown):v is {connectionRevision:number}{return typeof v==='object'&&v!==null&&Number.isInteger((v as any).connectionRevision)}
function isConnection(v:unknown):v is ConnectionSnapshot{return isRevision(v)&&typeof (v as any).connected==='boolean'}
function isSelection(v:unknown):v is SelectionSnapshot{return isRevision(v)&&((v as any).objectName===null||typeof (v as any).objectName==='string')}
function escape(value:string){return value.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string,string>)[c]);}
