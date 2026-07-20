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
function render(){
  if(!root)return;
  const objectName=schema?.name??selection.objectName;
  const objectKind=(schema?.kind??schema?.type??(objectName?'table':'database')).toUpperCase();
  let content:string;
  let status='等待数据库连接';
  if(error){content=`<div class="empty-state error" role="alert">${escape(error)}</div>`;status='结构加载失败';}
  else if(!connection?.connected||!selection.objectName){content='<div class="empty-state">请先连接数据库并选择对象。</div>';}
  else if(!schema){content=`<div class="empty-state">正在加载 ${escape(selection.objectName)} 的结构…</div>`;status=`正在加载 ${selection.objectName}`;}
  else{content=renderSchema(schema);status=`${schema.columns.length} 个字段`;}
  root.innerHTML=`<main class="workspace">
    <header class="workspace-heading"><div class="object-title"><small>${escape(objectKind)}</small><h1>${escape(objectName??'结构')}</h1>${schema&&!schema.writable?'<span class="readonly-badge">只读</span>':''}</div></header>
    <div class="view-host">${content}</div>
    <footer class="status-bar" role="status" aria-live="polite"><span>${escape(status)}</span><span>${connection?.connected?'ONLINE':'OFFLINE'}</span></footer>
  </main>`;
  if(!schema)return;
  root.querySelector<HTMLElement>('.ddl')!.textContent=schema.sql;
  root.querySelector('[data-action="copy-ddl"]')?.addEventListener('click',()=>void navigator.clipboard?.writeText(schema!.sql));
  root.querySelector('[data-action="toggle-wrap"]')?.addEventListener('click',()=>{wrap=!wrap;render();});
}
function renderSchema(value:Schema){
  const columns=table(['名称','类型','标记','默认值'],value.columns.map(c=>[c.name,c.type||'ANY',[c.primaryKeyOrder?`PK ${c.primaryKeyOrder}`:'',c.notNull?'NOT NULL':'',c.generated?'GENERATED':''].filter(Boolean).join(' · ')||'—',c.defaultValue??'—']));
  const indexes=value.indexes.map(i=>`<div class="index-row"><strong>${escape(i.name)}</strong><code>${escape(i.columns.join(', '))}</code><small>${escape([i.unique?'UNIQUE':'',i.origin.toUpperCase(),i.partial?'PARTIAL':''].filter(Boolean).join(' · '))}</small></div>`).join('')||'<div class="empty-state compact">无索引</div>';
  const foreignKeys=(value.foreignKeys??[]).map(f=>`<div class="index-row"><strong>${escape(f.from)}</strong><code>${escape(`${f.table}.${f.to??'(rowid)'}`)}</code><small>${escape(`ON UPDATE ${f.onUpdate} · ON DELETE ${f.onDelete}`)}</small></div>`).join('')||'<div class="empty-state compact">无外键</div>';
  const triggers=(value.triggers??[]).map(t=>`<div class="trigger-row"><strong>${escape(t.name)}</strong><pre class="sql-code">${escape(t.sql)}</pre></div>`).join('')||'<div class="empty-state compact">无触发器</div>';
  return `<div class="schema-view">
    <section class="schema-columns">${sectionTitle('字段',value.columns.length)}${columns}</section>
    <section class="schema-indexes">${sectionTitle('索引',value.indexes.length)}${indexes}</section>
    <section class="schema-foreign-keys">${sectionTitle('外键',value.foreignKeys?.length??0)}${foreignKeys}</section>
    <section class="schema-triggers">${sectionTitle('触发器',value.triggers?.length??0)}${triggers}</section>
    <section class="schema-definition">${sectionTitle('DDL')}<div class="code-toolbar"><button type="button" data-action="copy-ddl">复制 DDL</button><button type="button" data-action="toggle-wrap">${wrap?'不换行':'自动换行'}</button></div><pre class="sql-code ddl ${wrap?'':'nowrap'}"></pre></section>
  </div>`;
}
function sectionTitle(label:string,count?:number){return `<h2 class="section-title"><span>${escape(label)}</span>${count===undefined?'':`<b>${count}</b>`}</h2>`;}
function table(head:string[],rows:string[][]){return `<table><thead><tr>${head.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(v=>`<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}
function setError(value:unknown,rerender=true){error=value instanceof Error?value.message:String(value);if(rerender)render();}
function isRevision(v:unknown):v is {connectionRevision:number}{return typeof v==='object'&&v!==null&&Number.isInteger((v as any).connectionRevision)}
function isConnection(v:unknown):v is ConnectionSnapshot{return isRevision(v)&&typeof (v as any).connected==='boolean'}
function isSelection(v:unknown):v is SelectionSnapshot{return isRevision(v)&&((v as any).objectName===null||typeof (v as any).objectName==='string')}
function escape(value:string){return value.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string,string>)[c]);}
